from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.locking import SyncBusy, sync_lock
from app.main import create_app
from app.queries import data_status
from app.records import DataError
from app.source import SourceError
from app.sync import synchronize


def run_sync(db, settings, official, mode="full"):
    source = official.client(settings)
    try:
        return synchronize(db, settings, source, mode)
    finally:
        source.close()


def test_sync_is_idempotent_and_retains_originals(imported, settings, official):
    before = data_status(imported)
    result = run_sync(imported, settings, official)
    after = data_status(imported)
    assert result["inserted"] == result["revised"] == result["removed"] == 0
    assert before["total"] == after["total"] == 5
    assert before["dataset_fingerprint"] == after["dataset_fingerprint"]
    assert after["stored_versions"] == 5


def test_revision_saved_and_incremental_window_used(imported, settings, official):
    official.rows[-1]["valor"] = "122.00"
    result = run_sync(imported, settings, official, "incremental")
    assert result["revised"] == 1
    after = data_status(imported)
    assert after["total"] == 5 and after["stored_versions"] == 6
    assert after["last"]["value"] == "122.00"
    assert any("2024-01-05" in query.get("$where", "") for query in official.queries)


def test_storage_failure_rolls_back_entire_publication(imported, settings, official):
    before = data_status(imported)
    with imported.connect() as connection:
        connection.execute("""
            CREATE TRIGGER synthetic_storage_failure BEFORE INSERT ON records
            WHEN NEW.value = '122.00'
            BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;
        """)
    official.rows[-1]["valor"] = "122.00"
    with pytest.raises(SourceError, match="Error interno"):
        run_sync(imported, settings, official)
    after = data_status(imported)
    assert before["dataset_fingerprint"] == after["dataset_fingerprint"]
    assert after["total"] == after["stored_versions"] == 5
    assert after["last_attempt"]["status"] == "failed"


def test_old_remote_deletion_requires_full_resync(imported, settings, official):
    before = data_status(imported)
    official.rows.pop(0)
    with pytest.raises(SourceError, match="sincronización completa"):
        run_sync(imported, settings, official, "incremental")
    assert data_status(imported)["dataset_fingerprint"] == before["dataset_fingerprint"]
    result = run_sync(imported, settings, official, "full")
    assert result["removed"] == 1
    after = data_status(imported)
    assert after["total"] == 4 and after["stored_versions"] == 5


@pytest.mark.parametrize("failure", ["external", "invalid", "overlap", "empty"])
def test_failed_sync_preserves_validated_copy(imported, settings, official, failure):
    before = data_status(imported)
    if failure == "external":
        official.failure = 503
    elif failure == "invalid":
        official.rows[-1]["valor"] = "NaN"
    elif failure == "overlap":
        official.rows[-1]["vigenciadesde"] = "2024-01-06T00:00:00.000"
    else:
        official.rows.clear()
    with pytest.raises((SourceError, DataError)):
        run_sync(imported, settings, official)
    after = data_status(imported)
    assert after["dataset_fingerprint"] == before["dataset_fingerprint"]
    assert after["last_success"]["id"] == before["last_success"]["id"]
    assert after["state"] == "source_error" and after["total"] == 5
    if failure == "invalid":
        assert after["last_attempt"]["audit"]["rejected"] == 1


def test_concurrent_sync_locked_and_interrupted_run_recoverable(imported, settings, official):
    with sync_lock(imported.path), pytest.raises(SyncBusy):
        run_sync(imported, settings, official)
    with imported.connect() as connection:
        connection.execute(
            "INSERT INTO sync_runs(mode,status,started_at) VALUES('full','running','old')"
        )
    result = run_sync(imported, settings, official)
    assert result["status"] == "success"
    with imported.connect() as connection:
        old = connection.execute("SELECT * FROM sync_runs WHERE started_at='old'").fetchone()
    assert old["status"] == "failed" and "interrumpido" in old["error"]


@pytest.fixture
def client(imported, settings, official):
    app = create_app(settings, lambda: official.client(settings))
    with TestClient(app, client=("127.0.0.1", 12345)) as test_client:
        yield test_client


def test_health_status_openapi_and_available_years(client):
    assert client.get("/api/v1/health").json()["database"] == "ok"
    assert client.get("/api/v1/data/status").json()["total"] == 5
    assert client.get("/api/v1/trm/years").json() == [2024, 2023]
    assert "/api/v1/trm/history" in client.get("/openapi.json").json()["paths"]
    assert client.get("/api/v1/does-not-exist").json()["error"]["code"] == 404
    assert client.post("/api/v1/trm/latest").json()["error"]["code"] == 405


def test_filters_include_overlapping_validity_and_table_pagination(client):
    result = client.get("/api/v1/trm/history?year=2024&month=1&page_size=2&direction=asc").json()
    assert result["total"] == 5 and result["pages"] == 3
    assert result["items"][0]["valid_from"] == "2023-12-29"
    day = client.get("/api/v1/trm/history?start=2024-01-06&end=2024-01-06").json()
    assert day["total"] == 1 and day["items"][0]["value"] == "121.00"
    second = client.get("/api/v1/trm/history?page=2&page_size=2&direction=asc").json()
    assert second["items"][0]["valid_from"] == "2024-01-03"
    ordered = client.get("/api/v1/trm/history?sort=value&direction=desc").json()["items"]
    assert [Decimal(row["value"]) for row in ordered] == [121, 120, 110, 110, 100]


def test_series_uses_every_filtered_record_and_decimal_mean(client):
    result = client.get("/api/v1/trm/series?year=2024").json()
    assert result["count"] == len(result["points"]) == 5
    assert Decimal(result["mean"]) == Decimal("112.20")
    assert Decimal(result["minimum"]) == 100 and Decimal(result["maximum"]) == 121
    assert len([point for point in result["points"] if point["value"] == "110.00"]) == 2
    assert client.get("/api/v1/trm/series?year=2025").json()["mean"] is None


def test_latest_variation_and_staleness(client):
    result = client.get("/api/v1/trm/latest").json()
    assert result["state"] == "stale"
    assert Decimal(result["delta"]) == -1
    assert abs(Decimal(result["variation_pct"]) - (Decimal(120) / 121 - 1) * 100) < Decimal("1e-20")


def test_current_and_future_validity_distinguished(client, monkeypatch):
    from app import queries

    class Clock:
        @staticmethod
        def date():
            return date(2024, 1, 6)

    monkeypatch.setattr(queries, "now_bogota", lambda: Clock())
    result = client.get("/api/v1/trm/latest").json()
    assert result["state"] == "current" and result["record"]["value"] == "121.00"
    monkeypatch.setattr(Clock, "date", staticmethod(lambda: date(2020, 1, 1)))
    assert client.get("/api/v1/trm/latest").json()["state"] == "future"


@pytest.mark.parametrize(
    "params",
    [
        "start=2024-02-01&end=2024-01-01",
        "month=1",
        "year=bad",
        "month=13",
        "page=0",
        "page_size=201",
        "sort=value;DROP",
        "unknown=yes",
        "start=2024-02-30",
    ],
)
def test_invalid_query_rejected_with_consistent_errors(client, params):
    response = client.get("/api/v1/trm/history?" + params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == 422


def test_sync_endpoint_and_origin_protection(client):
    assert client.post("/api/v1/data/sync", json={"mode": "incremental"}).status_code == 200
    rejected = client.post(
        "/api/v1/data/sync", json={"mode": "full"}, headers={"Origin": "https://untrusted.example"}
    )
    assert rejected.status_code == 403
    assert client.post("/api/v1/data/sync", json={"mode": "invalid"}).status_code == 422


def test_remote_admin_requires_configured_token(settings, official):
    app = create_app(settings, lambda: official.client(settings))
    with TestClient(app, client=("203.0.113.1", 1234)) as remote:
        assert remote.post("/api/v1/data/sync", json={}).status_code == 403
    from pydantic import SecretStr

    settings.admin_token = SecretStr("synthetic-test-secret")
    with TestClient(app, client=("203.0.113.1", 1234)) as remote:
        assert remote.post("/api/v1/data/sync", json={}).status_code == 403
        assert (
            remote.post(
                "/api/v1/data/sync", json={}, headers={"X-Admin-Token": "synthetic-test-secret"}
            ).status_code
            == 200
        )


def test_empty_database_responses(db, settings):
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/trm/latest").json()["state"] == "empty"
        assert client.get("/api/v1/trm/history").json()["items"] == []
        assert client.get("/api/v1/trm/series").json()["count"] == 0
