import io
import json
import sqlite3
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest
from conftest import OfficialSourceDouble, synthetic_row
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.main import create_app
from app.projection import project
from app.records import normalize
from app.schemas import ProjectionRequest
from app.sync import synchronize


@pytest.fixture
def projection_client(db, settings, monkeypatch):
    # Irregular, contiguous validity intervals and nonconstant synthetic prices.
    rows, start = [], date(2024, 1, 1)
    for index in range(160):
        end = start + timedelta(days=3 if index % 5 == 0 else 0)
        rows.append(synthetic_row(str(start), f"{4000 + index + 30 * np.sin(index):.2f}", str(end)))
        start = end + timedelta(days=1)
    source = OfficialSourceDouble(rows).client(settings)
    synchronize(db, settings, source, "full")
    source.close()
    monkeypatch.setattr(
        "app.projection.now_bogota", lambda: datetime.combine(end, datetime.min.time())
    )
    with TestClient(create_app(settings)) as client:
        yield client, db, rows


def settings_body(**overrides):
    return dict(
        method="bootstrap", training_records=31, replicas=200, seed=42, horizon=5, **overrides
    )


@pytest.mark.parametrize("method", ["bootstrap", "monte_carlo"])
def test_projection_median_bands_reproducibility_and_saved_paths(projection_client, method):
    client, db, rows = projection_client
    body = settings_body()
    body["method"] = method
    response = client.post("/api/v1/projections", json=body)
    assert response.status_code == 201, response.text
    first = response.json()
    second = client.post("/api/v1/projections", json=body).json()
    assert first["experiment"]["numeric_fingerprint"] == second["experiment"]["numeric_fingerprint"]
    assert first["experiment"]["training"]["return_count"] == 30
    assert first["experiment"]["initial_price"] == float(rows[-1]["valor"])
    with db.connect() as connection:
        saved = connection.execute(
            "SELECT * FROM simulation_experiments WHERE id=?", (first["id"],)
        ).fetchone()
    paths = np.load(io.BytesIO(saved["paths_npz"]))[method]
    low, median, high = np.quantile(paths[:, -1], [0.05, 0.5, 0.95])
    assert first["estimate"] == median
    assert first["lower"] == low and first["upper"] == high
    assert first["change"] == median - paths[0, 0]
    assert first["relative_change"] == median / paths[0, 0] - 1
    assert client.get("/api/v1/projections/" + first["id"]).json() == first
    assert (
        client.post("/api/v1/exports/simulation", json={"experiment_id": first["id"]}).status_code
        == 200
    )
    assert len(json.loads(saved["snapshot_json"])) == 31


def test_future_record_is_not_the_initial_price(projection_client):
    client, db, rows = projection_client
    last_date = date.fromisoformat(rows[-1]["vigenciahasta"][:10])
    # Move today's clock back into the preceding extended validity.
    records = [normalize(row) for row in rows]
    cutoff = records[-5].valid_from
    experiment, _, training = project(records, ProjectionRequest(**settings_body()), cutoff, 5)
    assert experiment.initial_price == float(records[-5].value)
    assert all(row.valid_from <= cutoff for row in training)
    assert cutoff < last_date


def test_stale_or_insufficient_training_is_rejected(projection_client, monkeypatch):
    client, db, rows = projection_client
    end = date.fromisoformat(rows[-1]["vigenciahasta"][:10])
    monkeypatch.setattr(
        "app.projection.now_bogota",
        lambda: datetime.combine(end + timedelta(days=1), datetime.min.time()),
    )
    response = client.post("/api/v1/projections", json=settings_body())
    assert response.status_code == 422 and "vigente" in response.text
    body = settings_body()
    body["training_records"] = 200
    assert client.post("/api/v1/projections", json=body).status_code == 422


def test_holes_are_not_interpolated(projection_client):
    client, db, _ = projection_client
    with db.connect() as connection:
        connection.execute(
            "DELETE FROM records WHERE id=(SELECT id FROM records "
            "ORDER BY valid_from DESC LIMIT 1 OFFSET 5)"
        )
    response = client.post("/api/v1/projections", json=settings_body())
    assert response.status_code == 422 and "huecos" in response.text


def test_rolling_metrics_and_disjoint_evaluation_windows(projection_client):
    client, db, _ = projection_client
    body = dict(settings=settings_body(), horizons=[1, 5, 10], folds=4)
    response = client.post("/api/v1/validations/rolling", json=body)
    assert response.status_code == 201, response.text
    result = response.json()
    assert len(result["cases"]) == 12
    for summary in result["summaries"]:
        cases = [c for c in result["cases"] if c["horizon"] == summary["horizon"]]
        errors = np.array([c["predicted"] - c["actual"] for c in cases])
        baseline = np.array([c["initial"] - c["actual"] for c in cases])
        assert summary["model"]["mae"] == pytest.approx(np.abs(errors).mean())
        assert summary["model"]["rmse"] == pytest.approx(np.sqrt((errors**2).mean()))
        assert summary["baseline"]["mae"] == pytest.approx(np.abs(baseline).mean())
        assert summary["model"]["coverage"] == np.mean(
            [c["lower"] <= c["actual"] <= c["upper"] for c in cases]
        )
        assert summary["model"]["terminal_absolute_error"] is None
        for case in cases:
            experiment = client.get("/api/v1/simulations/" + case["experiment_id"]).json()
            assert case["predicted"] == experiment["methods"][0]["bands"][-1]["median"]
            assert experiment["request"]["cutoff_date"] == case["cutoff"]
            with db.connect() as connection:
                snapshot = json.loads(
                    connection.execute(
                        "SELECT snapshot_json FROM simulation_experiments WHERE id=?",
                        (case["experiment_id"],),
                    ).fetchone()[0]
                )
            assert len(snapshot) == 31
            assert max(r["vigenciadesde"][:10] for r in snapshot) <= case["cutoff"]
            assert case["target"] > case["cutoff"]
    assert client.get("/api/v1/validations/rolling/" + result["id"]).json() == result
    exported = client.get("/api/v1/exports/rolling/" + result["id"])
    assert exported.status_code == 200
    workbook = load_workbook(io.BytesIO(exported.content), read_only=True, data_only=True)
    assert len(list(workbook["Valores por corte"].rows)) == 13
    assert len(list(workbook["Entrenamiento"].rows)) == 12 * 31 + 1
    assert len(list(workbook["Evaluacion"].rows)) == 4 * (1 + 5 + 10) + 1
    workbook.close()


def test_rolling_future_price_change_cannot_change_earlier_projection(projection_client):
    client, db, rows = projection_client
    body = dict(settings=settings_body(), horizons=[5, 10], folds=3)
    first = client.post("/api/v1/validations/rolling", json=body).json()
    changed = dict(rows[-1], valor="99999.00")
    record = normalize(changed)
    with db.connect() as connection:
        connection.execute(
            "UPDATE records SET value=?,raw_json=?,fingerprint=? WHERE valid_from=?",
            ("99999.00", json.dumps(changed), record.fingerprint, str(record.valid_from)),
        )
    second = client.post("/api/v1/validations/rolling", json=body).json()
    assert [c["predicted"] for c in first["cases"]] == [c["predicted"] for c in second["cases"]]
    assert first["cases"][-1]["actual"] != second["cases"][-1]["actual"]
    assert first["summaries"][-1]["model"]["mae"] != second["summaries"][-1]["model"]["mae"]


@pytest.mark.parametrize(
    "path,body",
    [
        ("projections", {"training_records": 30}),
        ("projections", {"horizon": True}),
        ("projections", {"replicas": 99}),
        ("projections", {"target_date": "2099-01-01"}),
        ("validations/rolling", {"horizons": [5, 5]}),
        ("validations/rolling", {"horizons": [0]}),
        ("validations/rolling", {"horizons": [365, 364, 363], "folds": 12}),
    ],
)
def test_invalid_projection_requests(projection_client, path, body):
    client, _, _ = projection_client
    assert client.post("/api/v1/" + path, json=body).status_code == 422


def test_projection_guard_and_unknown_identifiers(projection_client):
    client, _, _ = projection_client
    with client.app.state.simulation_lock:
        assert client.post("/api/v1/projections", json=settings_body()).status_code == 429
        assert client.post("/api/v1/validations/rolling", json={}).status_code == 429
    for path in ["projections", "validations/rolling"]:
        assert client.get(f"/api/v1/{path}/00000000-0000-0000-0000-000000000000").status_code == 404


def test_rolling_declares_skipped_origins_at_gaps(projection_client):
    client, db, rows = projection_client
    with db.connect() as connection:
        connection.execute(
            "DELETE FROM records WHERE valid_from=?", (rows[-15]["vigenciadesde"][:10],)
        )
    response = client.post(
        "/api/v1/validations/rolling",
        json={
            "settings": settings_body(),
            "horizons": [5, 10],
            "folds": 6,
        },
    )
    assert response.status_code == 201
    result = response.json()
    assert result["skipped"] > 0
    assert all(s["count"] == 6 - result["skipped"] for s in result["summaries"])


def test_failed_rolling_save_rolls_back_and_preserves_existing_experiments(
    projection_client, monkeypatch
):
    from app import projection

    client, db, _ = projection_client
    saved = client.post("/api/v1/projections", json=settings_body()).json()
    original_insert = projection.insert_experiment
    count = 0

    def fail_second_insert(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise sqlite3.OperationalError("Synthetic storage failure")
        original_insert(*args)

    monkeypatch.setattr(projection, "insert_experiment", fail_second_insert)
    with pytest.raises(sqlite3.OperationalError, match="Synthetic storage failure"):
        client.post(
            "/api/v1/validations/rolling",
            json={
                "settings": settings_body(),
                "horizons": [5],
                "folds": 2,
            },
        )
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM simulation_experiments").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM rolling_evaluations").fetchone()[0] == 0
    assert client.get("/api/v1/projections/" + saved["id"]).json() == saved


def test_colombia_cutoff_excludes_published_future_validities(projection_client, monkeypatch):
    from zoneinfo import ZoneInfo

    client, _, rows = projection_client
    cutoff = date.fromisoformat(rows[-5]["vigenciadesde"][:10])
    next_utc_day = datetime.combine(cutoff + timedelta(days=1), datetime.min.time(), UTC)
    monkeypatch.setattr(
        "app.projection.now_bogota", lambda: next_utc_day.astimezone(ZoneInfo("America/Bogota"))
    )
    response = client.post("/api/v1/projections", json=settings_body())
    assert response.status_code == 201
    result = response.json()
    assert result["as_of"] == str(cutoff)
    assert result["experiment"]["initial_price"] == float(rows[-5]["valor"])
