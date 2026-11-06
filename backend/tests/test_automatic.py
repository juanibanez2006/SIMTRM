import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from threading import Event
from zoneinfo import ZoneInfo

import httpx
import pytest
from conftest import synthetic_row
from fastapi.testclient import TestClient

from app.automatic import AutomaticSync
from app.db import Database
from app.locking import SyncBusy, sync_lock
from app.main import create_app
from app.queries import data_status, latest
from app.source import SocrataClient, SourceError
from app.sync import recover_interrupted_sync, synchronize


@pytest.fixture
def clock(monkeypatch):
    from app.config import now_bogota

    value = [now_bogota()]
    for module in ("app.sync", "app.automatic", "app.queries", "app.main"):
        monkeypatch.setattr(module + ".now_bogota", lambda: value[0])
    return value


def wait_until(predicate):
    end = time.monotonic() + 5
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("La tarea automática no alcanzó el estado esperado")


def test_empty_database_bootstraps_via_existing_incremental_service(db, settings, official):
    AutomaticSync(db, settings, lambda: official.client(settings)).check_once()
    status = data_status(db, settings)
    assert status["total"] == status["stored_versions"] == 5
    assert status["last_success"]["mode"] == "incremental"
    assert status["last_success"]["audit"]["window_start"] is None


def test_disabled_automatic_sync_does_not_start_a_worker(db, settings):
    def forbidden():
        pytest.fail("La actualización automática desactivada no debe crear clientes externos")

    app = create_app(settings, forbidden)
    with TestClient(app) as client:
        assert app.state.automatic_sync is None
        status = client.get("/api/v1/data/status").json()
        assert status["auto_sync_enabled"] is False
        assert status["next_auto_check_at"] is None


def test_new_published_record_becomes_current_only_when_its_validity_begins(
    imported, settings, official, monkeypatch
):
    official.rows.append(synthetic_row("2024-01-09", "122.00"))
    source = official.client(settings)
    try:
        synchronize(imported, settings, source, "incremental")
    finally:
        source.close()
    for day, value, state in [
        (8, "120.00", "current"),
        (9, "122.00", "current"),
        (10, "122.00", "stale"),
    ]:
        moment = datetime(2024, 1, day, 0, 0, tzinfo=ZoneInfo("America/Bogota"))
        monkeypatch.setattr("app.queries.now_bogota", lambda moment=moment: moment)
        result = latest(imported)
        assert result["state"] == state and result["record"]["value"] == value


def test_fresh_skip_six_hour_check_idempotence_and_manual_override(
    imported, settings, official, clock
):
    worker = AutomaticSync(imported, settings, lambda: official.client(settings))
    official.queries.clear()
    worker.check_once()
    assert official.queries == []
    clock[0] += timedelta(hours=6, seconds=1)
    official.rows.append(synthetic_row("2024-01-09", "122.00"))
    worker.check_once()
    status = data_status(imported, settings)
    assert status["total"] == status["stored_versions"] == 6
    assert status["last_success"]["mode"] == "incremental"
    assert status["last_success"]["audit"]["trigger"] == "automatic"
    count = len(official.queries)
    worker.check_once()
    assert len(official.queries) == count
    source = official.client(settings)
    try:
        result = synchronize(imported, settings, source, "incremental")
    finally:
        source.close()
    assert result["inserted"] == result["revised"] == 0
    assert len(official.queries) > count  # Manual checks do not observe the automatic interval.
    assert data_status(imported)["total"] == 6


@pytest.mark.parametrize("failure", ["503", "network"])
def test_failure_preserves_copy_cooldown_survives_restart_and_recovers(
    imported, settings, official, clock, failure
):
    clock[0] += timedelta(days=7)
    before = data_status(imported)
    attempts = []
    broken = [True]

    def handler(request):
        attempts.append(1)
        if broken[0]:
            if failure == "network":
                raise httpx.ConnectError("Synthetic offline source", request=request)
            return httpx.Response(503)
        return official.handler(request)

    def factory():
        return SocrataClient(settings, transport=httpx.MockTransport(handler))

    with pytest.raises(SourceError):
        AutomaticSync(imported, settings, factory).check_once()
    after = data_status(imported)
    assert after["dataset_fingerprint"] == before["dataset_fingerprint"]
    assert after["stored_versions"] == before["stored_versions"]
    assert after["last_success"] == before["last_success"]
    assert after["state"] == "source_error"
    assert len(attempts) == settings.source_retries + 1
    # A new process/object must honor the persisted failed attempt's cooldown.
    AutomaticSync(imported, settings, factory).check_once()
    assert len(attempts) == settings.source_retries + 1
    clock[0] += timedelta(hours=6, seconds=1)
    broken[0] = False
    official.rows.append(synthetic_row("2024-01-09", "122.00"))
    AutomaticSync(imported, settings, factory).check_once()
    recovered = data_status(imported)
    assert recovered["state"] == "local" and recovered["total"] == 6
    assert recovered["last_success"]["id"] > before["last_success"]["id"]


def test_startup_nonblocking_periodic_check_and_clean_shutdown(
    imported, settings, official, clock, monkeypatch
):
    monkeypatch.setattr("app.automatic.POLL_SECONDS", 0.01)
    clock[0] += timedelta(days=7)
    started, release = Event(), Event()

    def handler(request):
        started.set()
        assert release.wait(5)
        return official.handler(request)

    settings.auto_sync_enabled = True
    app = create_app(
        settings, lambda: SocrataClient(settings, transport=httpx.MockTransport(handler))
    )
    try:
        with TestClient(app) as client:
            assert started.wait(2)
            assert client.get("/api/v1/health").status_code == 200
            release.set()
            wait_until(lambda: data_status(imported)["last_success"]["id"] == 2)
            clock[0] += timedelta(hours=6, seconds=1)
            wait_until(lambda: data_status(imported)["last_success"]["id"] == 3)
            status = client.get("/api/v1/data/status").json()
            assert status["auto_sync_enabled"] is True
            assert status["auto_sync_interval_hours"] == 6
            assert status["checked_at"] and status["next_auto_check_at"]
    finally:
        release.set()
    assert not app.state.automatic_sync.thread.is_alive()
    with sync_lock(imported.path, suffix=".automatic.lock"):
        pass


def test_shutdown_cancels_backoff_without_touching_validated_history(
    imported, settings, official, clock
):
    clock[0] += timedelta(days=7)
    before = data_status(imported)
    started = Event()
    settings.source_backoff_seconds = 30

    def handler(request):
        started.set()
        return httpx.Response(503)

    worker = AutomaticSync(
        imported,
        settings,
        lambda: SocrataClient(settings, transport=httpx.MockTransport(handler)),
    )
    worker.start()
    try:
        assert started.wait(2)
        start = time.monotonic()
        worker.stop()
        worker.join()
        assert time.monotonic() - start < 2
    finally:
        worker.stop()
        worker.join()
    after = data_status(imported)
    assert after["dataset_fingerprint"] == before["dataset_fingerprint"]
    assert after["last_success"] == before["last_success"]
    assert after["last_attempt"]["audit"]["cancelled"] == 1


def test_manual_and_automatic_cannot_publish_concurrently(imported, settings, official, clock):
    clock[0] += timedelta(days=7)
    started, release = Event(), Event()

    def handler(request):
        started.set()
        assert release.wait(5)
        return official.handler(request)

    worker = AutomaticSync(
        imported,
        settings,
        lambda: SocrataClient(settings, transport=httpx.MockTransport(handler)),
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(worker.check_once)
        try:
            assert started.wait(2)
            recover = data_status(imported)
            with pytest.raises(SyncBusy):
                recover_interrupted_sync(imported)
            assert data_status(imported)["last_attempt"] == recover["last_attempt"]
            source = official.client(settings)
            try:
                with pytest.raises(SyncBusy):
                    synchronize(imported, settings, source, "incremental")
                with pytest.raises(SyncBusy):
                    other = AutomaticSync(imported, settings, lambda: official.client(settings))
                    other.check_once()
            finally:
                source.close()
        finally:
            release.set()
        future.result(timeout=5)
    assert data_status(imported)["last_success"]["id"] == 2


def test_due_check_is_repeated_under_publication_lock(imported, settings, official, clock):
    clock[0] += timedelta(days=7)
    worker = AutomaticSync(imported, settings, lambda: official.client(settings))
    worker.check_once()
    official.queries.clear()
    source = official.client(settings)
    try:
        assert synchronize(imported, settings, source, "incremental", automatic=True) is None
    finally:
        source.close()
    assert official.queries == []


def test_other_process_leadership_crash_and_orphan_recovery(
    imported, settings, official, clock, monkeypatch
):
    monkeypatch.setattr("app.automatic.POLL_SECONDS", 0.01)
    clock[0] += timedelta(days=7)
    script = """
import os,sys
from pathlib import Path
from app.db import Database
from app.locking import sync_lock
db=Database(Path(sys.argv[1]))
with sync_lock(db.path,suffix='.automatic.lock'),sync_lock(db.path):
 with db.connect() as connection:
  connection.execute(
   "INSERT INTO sync_runs(mode,status,started_at) "
   "VALUES('incremental','running','interrupted-test')")
 print('locked',flush=True)
 sys.stdin.readline()
 os._exit(0)
"""
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(imported.path)],
        cwd=Path(__file__).resolve().parents[1],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    called = Event()

    def factory():
        called.set()
        return official.client(settings)

    worker = AutomaticSync(imported, settings, factory)
    try:
        assert process.stdout.readline().strip() == "locked"
        worker.start()
        assert not called.wait(0.1)  # Standby instances do not contact the source.
        process.communicate("crash\n", timeout=5)
        assert called.wait(5)
        wait_until(lambda: data_status(imported)["last_attempt"]["status"] == "success")
        with imported.connect() as connection:
            orphan = connection.execute("SELECT * FROM sync_runs WHERE id=2").fetchone()
        assert orphan["status"] == "failed"
        assert json.loads(orphan["audit_json"])["interrupted"] == 1
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
        worker.stop()
        if worker.thread.ident is not None:
            worker.join()


def test_history_count_and_rows_share_snapshot_during_sync(
    imported, settings, official, monkeypatch
):
    original = imported.connect
    injected = [False]

    @contextmanager
    def interleaved():
        with original() as connection:

            class Connection:
                def execute(self, sql, params=()):
                    result = connection.execute(sql, params)
                    if sql.startswith("SELECT COUNT(*) FROM records") and not injected[0]:
                        injected[0] = True
                        official.rows.append(synthetic_row("2024-01-09", "122.00"))
                        source = official.client(settings)
                        try:
                            synchronize(Database(imported.path), settings, source, "incremental")
                        finally:
                            source.close()
                    return result

            yield Connection()

    app = create_app(settings, lambda: official.client(settings))
    with TestClient(app) as client:
        monkeypatch.setattr(app.state.db, "connect", interleaved)
        response = client.get("/api/v1/trm/history?page_size=200").json()
        assert response["total"] == len(response["items"]) == 5
        response = client.get("/api/v1/trm/history?page_size=200").json()
        assert response["total"] == len(response["items"]) == 6
