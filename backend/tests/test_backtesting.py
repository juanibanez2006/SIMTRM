import json
import math

import numpy as np
import pytest
from conftest import synthetic_row
from fastapi.testclient import TestClient
from scipy import stats

from app.backtesting import evaluation_metrics
from app.diagnostics import generator_diagnostics, model_diagnostics
from app.main import create_app
from app.queries import data_status
from app.records import normalize


@pytest.fixture
def client(imported, settings):
    with TestClient(create_app(settings)) as client:
        yield client


def body(**overrides):
    return {
        "training_start": "2024-01-01",
        "cutoff_date": "2024-01-03",
        "method": "both",
        "horizon": 2,
        "replicas": 100,
        "seed": 2026,
        "uniform_count": 250,
        "alpha": 0.05,
        **overrides,
    }


def test_error_formulas_against_known_values():
    actual, predicted = np.array([100.0, 200.0]), np.array([110.0, 180.0])
    result = evaluation_metrics(actual, predicted, True, 0.5)
    assert result["mae"] == 15
    assert result["rmse"] == pytest.approx(math.sqrt(250))
    assert result["mape"] == 0.1 and result["coverage"] == 0.5
    assert result["terminal_absolute_error"] == 20
    assert result["terminal_relative_error"] == 0.1
    assert evaluation_metrics(actual, predicted, False)["terminal_absolute_error"] is None
    assert all(
        value is None for value in evaluation_metrics(np.array([]), np.array([]), False).values()
    )


def test_complete_backtest_and_persistence_reference(client, imported):
    before = data_status(imported)
    response = client.post("/api/v1/backtests", json=body())
    assert response.status_code == 201
    result = response.json()
    assert result["status"] == "complete" and result["evaluated_steps"] == 2
    assert result["initial_price"] == 110
    assert [row["date"] for row in result["observations"]] == ["2024-01-04", "2024-01-08"]
    assert result["baseline"]["mae"] == 10.5
    assert result["baseline"]["rmse"] == pytest.approx(math.sqrt((121 + 100) / 2))
    assert result["baseline"]["coverage"] is None
    for model in result["methods"]:
        assert len(model["points"]) == 2
        errors = [point["predicted_mean"] - point["actual"] for point in model["points"]]
        assert model["metrics"]["mae"] == pytest.approx(sum(abs(error) for error in errors) / 2)
        assert (
            model["metrics"]["coverage"] == sum(point["covered"] for point in model["points"]) / 2
        )
        assert model["metrics"]["terminal_absolute_error"] == abs(errors[-1])
    assert client.get("/api/v1/backtests/" + result["id"]).json() == result
    assert data_status(imported) == before
    with imported.connect() as connection:
        saved = connection.execute("SELECT * FROM backtests WHERE id=?", (result["id"],)).fetchone()
        assert len(json.loads(saved["evaluation_snapshot_json"])) == 2


def test_no_future_observation_enters_calibration(client, imported):
    first = client.post("/api/v1/backtests", json=body()).json()
    first_model = client.get("/api/v1/simulations/" + first["experiment_id"]).json()
    raw = synthetic_row("2024-01-04", "9999.00", "2024-01-07")
    normalized = normalize(raw)
    with imported.connect() as connection:
        connection.execute(
            "UPDATE records SET value=?,raw_json=?,fingerprint=? WHERE valid_from=?",
            ("9999.00", json.dumps(raw), normalized.fingerprint, "2024-01-04"),
        )
    second = client.post("/api/v1/backtests", json=body()).json()
    second_model = client.get("/api/v1/simulations/" + second["experiment_id"]).json()
    assert first_model["numeric_fingerprint"] == second_model["numeric_fingerprint"]
    assert first["training_fingerprint"] == second["training_fingerprint"]
    assert first["evaluation_fingerprint"] != second["evaluation_fingerprint"]
    assert first["model_diagnostics"] == second["model_diagnostics"]
    with imported.connect() as connection:
        stored = connection.execute(
            "SELECT snapshot_json FROM simulation_experiments WHERE id=?",
            (second["experiment_id"],),
        ).fetchone()
    assert all(
        row["vigenciadesde"][:10] <= "2024-01-03" for row in json.loads(stored["snapshot_json"])
    )


def test_insufficient_future_history_reports_partial_metrics_without_terminal_error(client):
    result = client.post("/api/v1/backtests", json=body(horizon=4)).json()
    assert result["status"] == "insufficient" and result["evaluated_steps"] == 2
    for method in result["methods"]:
        assert method["metrics"]["mae"] is not None
        assert method["metrics"]["terminal_absolute_error"] is None
    empty = client.post("/api/v1/backtests", json=body(cutoff_date="2024-01-08")).json()
    assert empty["status"] == "insufficient" and empty["evaluated_steps"] == 0
    assert all(value is None for value in empty["baseline"].values())


def test_cut_inside_extended_validity_counts_only_new_records(client):
    result = client.post("/api/v1/backtests", json=body(cutoff_date="2024-01-05", horizon=1)).json()
    assert result["status"] == "complete"
    assert result["initial_price"] == 121
    assert result["observations"] == [{"date": "2024-01-08", "value": 120}]


def test_backtest_stops_at_gap_and_does_not_skip_a_model_step(client, imported):
    with imported.connect() as connection:
        connection.execute("DELETE FROM records WHERE valid_from='2024-01-04'")
    result = client.post("/api/v1/backtests", json=body()).json()
    assert result["status"] == "insufficient" and result["stopped_at_gap"]
    assert result["evaluated_steps"] == 0 and result["observations"] == []


@pytest.mark.parametrize(
    "override",
    [
        {"cutoff_date": "2099-01-01"},
        {"training_start": "2025-01-01"},
        {"horizon": 0},
        {"replicas": 50001},
        {"horizon": 365, "replicas": 50000},
        {"seed": True},
        {"uniform_count": 249},
        {"uniform_count": 10001},
        {"alpha": 0.04},
        {"unknown": True},
    ],
)
def test_invalid_requests_are_rejected(client, override):
    response = client.post("/api/v1/backtests", json=body(**override))
    assert response.status_code == 422 and response.json()["error"]["code"] == 422


def test_backtests_offline_and_shared_computation_guard(client, monkeypatch):
    from app.source import SocrataClient

    monkeypatch.setattr(
        SocrataClient, "request", lambda *args, **kwargs: pytest.fail("No debe consultar internet")
    )
    assert client.post("/api/v1/backtests", json=body()).status_code == 201
    with client.app.state.simulation_lock:
        assert client.post("/api/v1/backtests", json=body()).status_code == 429
    assert client.get("/api/v1/backtests/00000000-0000-0000-0000-000000000000").status_code == 404


def test_uniformity_formula_and_series_detect_joint_dependence(monkeypatch):
    # Deterministic synthetic grid, intentionally ordered to create dependence.
    values = (np.arange(250) + 0.5) / 250

    class Generator:
        def random(self, count):
            assert count == 250
            return values

    monkeypatch.setattr(np.random, "default_rng", lambda seed: Generator())
    result = generator_diagnostics(42, 250, 0.05)
    assert result["d_plus"] == result["d_minus"] == pytest.approx(0.002)
    assert result["tests"][0]["statistic"] == pytest.approx(
        stats.kstest(values, "uniform").statistic
    )
    assert result["frequencies"] == [25] * 10
    assert result["tests"][1]["statistic"] == 0
    assert result["tests"][2]["statistic"] == 500
    assert result["tests"][2]["decision"] == "reject"
    assert result["series_expected_frequency"] == 5 and sum(result["series_frequencies"]) == 125


def test_generator_reproducibility_and_valid_probabilities_without_demanding_all_tests_pass():
    first = generator_diagnostics(2026, 1001, 0.05)
    second = generator_diagnostics(2026, 1001, 0.05)
    assert first == second
    assert first["series_pairs"] == 500
    assert all(0 <= test["p_value"] <= 1 for test in first["tests"])
    assert all(0 <= value < 1 for value in first["uniforms"])
    assert first["mean"] == pytest.approx(sum(first["uniforms"]) / 1001)


def test_model_diagnostics_handle_small_constant_samples_and_do_not_cross_gaps():
    rows = [
        normalize(synthetic_row(day, value))
        for day, value in [
            ("2024-01-01", "100"),
            ("2024-01-02", "110"),
            ("2024-01-03", "121"),
            ("2024-01-06", "200"),
            ("2024-01-07", "220"),
        ]
    ]
    result = model_diagnostics(rows, 0.05)
    assert result["normality"]["decision"] == "not_applicable"
    assert result["normality"]["p_value"] is None
    assert result["correlation_pairs"] == 1 and result["lag_one_correlation"] is None
