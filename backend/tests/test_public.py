import io
import math
from datetime import timedelta

import pytest
from conftest import synthetic_row
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from pydantic import SecretStr, ValidationError

from app.access import visitor
from app.config import Settings, now_bogota
from app.main import create_app
from app.public import COOKIE, SESSION_TTL, session_owner, signed_session
from app.records import normalize
from app.sync import INSERT_RECORD

ORIGIN = "https://simtrm.example"


@pytest.fixture
def public_settings(settings, tmp_path, db):
    frontend = tmp_path / "frontend"
    (frontend / "assets").mkdir(parents=True)
    (frontend / "index.html").write_text('<html><body>SIMTRM</body></html>', encoding="utf-8")
    (frontend / "assets" / "main.js").write_text('console.log("SIMTRM")', encoding="utf-8")
    today = now_bogota().date()
    records = [normalize(synthetic_row(
        str(today - timedelta(days=499-i)), f"{4000 + i * .1 + 30 * math.sin(i):.2f}"
    )) for i in range(500)]
    with db.connect() as connection:
        connection.executemany(
            INSERT_RECORD, [r.storage(now_bogota().isoformat()) for r in records]
        )
    return settings.model_copy(update=dict(
        public_mode=True, public_origin=ORIGIN, frontend_dist_path=frontend,
        session_secret=SecretStr("synthetic-session-secret-" + "s" * 32),
        admin_token=SecretStr("synthetic-admin-secret-" + "a" * 32),
    ))


def projection_request(**overrides):
    return dict(target_date=str(now_bogota().date() + timedelta(days=30)),
                training_records=64, replicas=100, seed=78, **overrides)


def test_public_configuration_fails_closed_without_secrets_and_https():
    for params in (dict(public_mode=True), dict(public_mode=True, public_origin="http://bad.example")):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, **params)


def test_signed_sessions_reject_tampering_future_and_expiration():
    secret, owner, now = "s" * 48, "a" * 32, 1795464000
    signed = signed_session(owner, secret, now)
    assert session_owner(signed, secret, now) == owner
    assert session_owner(signed, secret, now + SESSION_TTL) == owner
    for value in ("bad", signed[:-1] + ("0" if signed[-1] != "0" else "1"),
                  signed.replace(owner, "b" * 32)):
        assert session_owner(value, secret, now) is None
    assert session_owner(signed, secret, now-1) is None
    assert session_owner(signed, secret, now + SESSION_TTL + 1) is None


def test_production_serves_built_frontend_and_protects_static_and_admin(public_settings):
    app = create_app(public_settings)
    with TestClient(app, base_url=ORIGIN) as client:
        page = client.get("/")
        assert page.status_code == 200 and "SIMTRM" in page.text
        assert page.headers["x-content-type-options"] == "nosniff"
        assert page.headers["x-frame-options"] == "DENY"
        assert "script-src 'self'" in page.headers["content-security-policy"]
        assert "max-age" in page.headers["strict-transport-security"]
        assert client.get("/assets/main.js").headers["cache-control"].endswith("immutable")
        assert client.get("/api/v1/health").json()["database"] == "ok"
        for path in ("/docs", "/openapi.json", "/backend/.env", "/data/simtrm.sqlite3",
                     "/api/does-not-exist"):
            assert client.get(path).status_code == 404
        client.cookies.clear()
        status = client.get("/api/v1/data/status")
        assert status.json()["manual_sync_available"] is False
        assert status.headers["cache-control"] == "no-store"
        cookie = status.headers["set-cookie"]
        assert all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=Lax", "Path=/"))
        assert "Domain=" not in cookie
        assert client.post("/api/v1/data/sync", json={}).status_code == 403
        assert client.post("/api/v1/projections", json=projection_request(),
                           headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.get("/", headers={"Host": "evil.example"}).status_code == 400
        assert client.post("/api/v1/projections", content="x" * 65537).status_code == 413
        assert client.get("/api/v1/trm/latest?" + "x" * 4097).status_code == 413
        assert client.post("/api/v1/projections", content="{bad").status_code == 422


@pytest.mark.parametrize("method", ["bootstrap", "monte_carlo", "arima"])
def test_browser_ownership_covers_children_exports_and_replay(public_settings, method):
    app = create_app(public_settings)
    with TestClient(app, base_url=ORIGIN) as alice, TestClient(app, base_url=ORIGIN) as bob:
        response = alice.post("/api/v1/projections", json=projection_request(method=method))
        assert response.status_code == 201, response.text
        original = response.json()
        id = original["id"]
        assert visitor.get() is None
        assert any(e["id"] == id for e in alice.get("/api/v1/experiments").json())
        assert bob.get("/api/v1/experiments").json() == []
        paths = [f"/api/v1/projections/{id}", f"/api/v1/simulations/{id}",
                 f"/api/v1/exports/projection/{id}"]
        if original["validation"]:
            validation = original["validation"]
            assert alice.get("/api/v1/validations/rolling").json()["total"] == 1
            assert bob.get("/api/v1/validations/rolling").json()["total"] == 0
            paths += [f"/api/v1/validations/rolling/{validation['id']}",
                      f"/api/v1/exports/rolling/{validation['id']}",
                      f"/api/v1/simulations/{validation['cases'][0]['experiment_id']}"]
        for path in paths:
            assert alice.get(path).status_code == 200, path
            assert bob.get(path).status_code == 404, path
        for path, body in [("/api/v1/exports/simulation", {"experiment_id": id}),
                           ("/api/v1/exports/scenarios", {"ids": [id]})]:
            assert alice.post(path, json=body).status_code == 200
            assert bob.post(path, json=body).status_code == 404
        replay = alice.post(f"/api/v1/projections/{id}/replay")
        assert replay.status_code == 201, replay.text
        assert replay.json()["experiment"]["numeric_fingerprint"] == (
            original["experiment"]["numeric_fingerprint"]
        )
        assert bob.post(f"/api/v1/projections/{id}/replay").status_code == 404
        excel = alice.get(f"/api/v1/exports/projection/{id}")
        book = load_workbook(io.BytesIO(excel.content))
        assert book["Resumen"]["B6"].value == pytest.approx(original["estimate"])
        assert len(book["Gráficos"]._charts) == 1
        book.close()


def test_saved_results_and_session_survive_app_restart(public_settings):
    with TestClient(create_app(public_settings), base_url=ORIGIN) as first:
        result = first.post("/api/v1/validations/rolling", json=dict(
            settings=dict(training_records=64, replicas=100), horizons=[1, 5], folds=2,
            unit="calendar_days",
        ))
        assert result.status_code == 201, result.text
        original, cookies = result.json(), first.cookies
    with TestClient(create_app(public_settings), base_url=ORIGIN) as restarted:
        restarted.cookies.update(cookies)
        assert restarted.get(f"/api/v1/validations/rolling/{original['id']}").json() == original
        assert restarted.get("/api/v1/validations/rolling").json()["total"] == 1
        restarted.cookies.set(COOKIE, "forged", domain="simtrm.example", path="/")
        assert restarted.get(f"/api/v1/validations/rolling/{original['id']}").status_code == 404


def test_public_technical_experiments_and_individual_backtests_are_owned(public_settings):
    app = create_app(public_settings)
    today = now_bogota().date()
    body = dict(training_start=str(today-timedelta(days=100)),
                cutoff_date=str(today-timedelta(days=10)), replicas=100, horizon=2)
    with TestClient(app, base_url=ORIGIN) as alice, TestClient(app, base_url=ORIGIN) as bob:
        simulation = alice.post("/api/v1/simulations", json={
            **body, "training_end": body["cutoff_date"], "method": "both",
        })
        assert simulation.status_code == 201, simulation.text
        id = simulation.json()["id"]
        assert alice.get(f"/api/v1/simulations/{id}").status_code == 200
        assert bob.get(f"/api/v1/simulations/{id}").status_code == 404
        assert alice.post(f"/api/v1/simulations/{id}/replay").status_code == 201
        backtest = alice.post("/api/v1/backtests", json=body)
        assert backtest.status_code == 201, backtest.text
        for path in (f"/api/v1/backtests/{backtest.json()['id']}",
                     f"/api/v1/exports/backtest/{backtest.json()['id']}"):
            assert alice.get(path).status_code == 200
            assert bob.get(path).status_code == 404


def test_public_work_quotas_and_shared_memory_lock(public_settings):
    limited = public_settings.model_copy(update=dict(public_jobs_per_hour=1))
    app = create_app(limited)
    assert app.state.simulation_lock is app.state.export_lock
    with TestClient(app, base_url=ORIGIN) as client:
        with app.state.simulation_lock:
            assert client.get("/api/v1/exports/history").status_code == 429
        # The rejected export consumed one quota slot; reads still work.
        response = client.post("/api/v1/projections", json=projection_request())
        assert response.status_code == 429 and int(response.headers["Retry-After"]) > 0
        assert client.get("/api/v1/trm/latest").status_code == 200
    app = create_app(public_settings.model_copy(update=dict(public_requests_per_minute=2)))
    with TestClient(app, base_url=ORIGIN) as client:
        assert client.get("/api/v1/trm/years").status_code == 200
        assert client.get("/api/v1/trm/years").status_code == 200
        assert client.get("/api/v1/trm/years").status_code == 429
        assert client.get("/api/v1/health").status_code == 200


def test_storage_guard_keeps_existing_results_readable(public_settings, monkeypatch):
    app = create_app(public_settings)
    with TestClient(app, base_url=ORIGIN) as client:
        result = client.post("/api/v1/projections", json=projection_request())
        assert result.status_code == 201, result.text
        from collections import namedtuple
        usage = namedtuple("usage", "total used free")
        monkeypatch.setattr("app.public.shutil.disk_usage", lambda _: usage(500, 499, 1))
        assert client.post("/api/v1/projections", json=projection_request()).status_code == 507
        assert client.get(f"/api/v1/projections/{result.json()['id']}").json() == result.json()
        assert client.get(f"/api/v1/exports/projection/{result.json()['id']}").status_code == 200
