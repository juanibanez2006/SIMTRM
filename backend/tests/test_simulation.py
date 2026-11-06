import io
import json
import math
from datetime import date, timedelta

import numpy as np
import pytest
from conftest import synthetic_row
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import create_app
from app.queries import data_status
from app.records import normalize
from app.schemas import SimulationRequest
from app.simulation import (
    SimulationError,
    prepare_training,
    run_experiment,
    simulate_paths,
    summarize_paths,
)

TODAY = date(2026, 11, 5)


def request(**overrides):
    return SimulationRequest(
        **{
            "training_start": "2024-01-01",
            "training_end": "2024-01-08",
            "cutoff_date": "2024-01-08",
            "replicas": 100,
            "horizon": 3,
            "display_paths": 10,
            **overrides,
        }
    )


def sample(values, start="2024-01-01"):
    return [
        normalize(synthetic_row(str(date.fromisoformat(start) + timedelta(days=index)), str(value)))
        for index, value in enumerate(values)
    ]


def experiment(rows, **overrides):
    return run_experiment([normalize(row) for row in rows], request(**overrides), TODAY)


def test_calibration_matches_known_log_returns_and_does_not_repeat_validity(rows):
    selected, logs, metadata = prepare_training([normalize(row) for row in rows], request(), TODAY)
    expected = [math.log(1.1), 0, math.log(1.1), math.log(120 / 121)]
    assert logs.tolist() == pytest.approx(expected)
    assert metadata["record_count"] == 5 and metadata["return_count"] == 4
    assert metadata["extended_records"] == 2
    mean = sum(expected) / len(expected)
    sigma = math.sqrt(sum((x - mean) ** 2 for x in expected) / 3)
    assert metadata["mu"] == pytest.approx(mean)
    assert metadata["sigma"] == pytest.approx(sigma)
    assert selected[-1].value == 120


@pytest.mark.parametrize("method", ["monte_carlo", "bootstrap"])
def test_seed_reproducibility_positive_shape_initial_and_full_storage(rows, method):
    first, archive, _ = experiment(rows, method=method, replicas=123, horizon=7)
    second, _, _ = experiment(rows, method=method, replicas=123, horizon=7)
    assert first.numeric_fingerprint == second.numeric_fingerprint
    assert first.methods == second.methods and first.id != second.id
    with np.load(io.BytesIO(archive), allow_pickle=False) as matrices:
        paths = matrices[method]
        assert paths.shape == (123, 8)
        assert np.all(paths[:, 0] == 120)
        assert np.all(np.isfinite(paths)) and np.all(paths > 0)
        assert np.array_equal(paths[:10], first.methods[0].paths)
        assert paths[:, -1].tolist() == first.methods[0].terminal_values
    assert first.methods[0].displayed_paths == 10
    assert first.methods[0].total_paths == len(first.methods[0].terminal_values) == 123


def test_changing_seed_changes_numerical_result(rows):
    first, _, _ = experiment(rows, seed=12)
    second, _, _ = experiment(rows, seed=13)
    assert first.numeric_fingerprint != second.numeric_fingerprint
    assert first.methods[0].terminal_values != second.methods[0].terminal_values


def test_both_methods_match_single_method_execution_and_preserve_shared_inputs(rows):
    both, archive, _ = experiment(rows)
    assert [item.method for item in both.methods] == ["monte_carlo", "bootstrap"]
    for method in both.methods:
        single, _, _ = experiment(rows, method=method.method)
        assert method == single.methods[0]
    with np.load(io.BytesIO(archive), allow_pickle=False) as matrices:
        assert set(matrices.files) == {"monte_carlo", "bootstrap"}


def test_bootstrap_uses_only_observed_log_returns():
    logs = np.array([-0.1, 0.0, 0.2])
    config = request(method="bootstrap", replicas=50, horizon=9)
    paths = simulate_paths(logs, config, "bootstrap", 100)
    recovered = np.log(paths[:, 1:] / paths[:, :-1])
    assert all(np.min(abs(logs - value)) < 1e-14 for value in recovered.flat)


def test_monte_carlo_recurrence_against_independent_scalar_updates():
    logs = np.array([-math.log(2), 0.0, math.log(2)])
    config = request(method="monte_carlo", replicas=3, horizon=4, seed=7)
    innovations = np.random.default_rng(7).normal(0, math.log(2), size=(3, 4))
    expected = []
    for replica in innovations:
        prices = [100.0]
        for increment in replica:
            prices.append(prices[-1] * math.exp(increment))
        expected.append(prices)
    assert simulate_paths(logs, config, "monte_carlo", 100) == pytest.approx(np.array(expected))


@pytest.mark.parametrize("method", ["monte_carlo", "bootstrap"])
def test_zero_volatility_is_deterministic_and_equal_initial_event_exact(method):
    records = sample([100, 100, 100, 100])
    result, _, _ = run_experiment(records, request(method=method), TODAY)
    assert result.training.sigma == 0
    assert all(price == 100 for path in result.methods[0].paths for price in path)
    probabilities = {row.event: row for row in result.methods[0].probabilities}
    assert probabilities["equal_initial"].probability == 1
    assert (
        probabilities["above_initial"].probability
        == probabilities["below_initial"].probability
        == 0
    )
    assert result.methods[0].terminal_summary.sample_std == 0


def test_constant_log_return_matches_analytic_growth():
    records = sample([100, 110, 121])
    result, _, _ = run_experiment(records, request(), TODAY)
    assert result.training.sigma == 0
    for method in result.methods:
        assert method.terminal_summary.mean == pytest.approx(121 * 1.1**3)


def test_one_step_one_replica_and_custom_initial_price(rows):
    result, _, _ = experiment(rows, horizon=1, replicas=1, initial_price="150.50")
    assert result.initial_price == 150.5 and result.initial_price_origin == "configured"
    for method in result.methods:
        assert len(method.bands) == 2 and len(method.paths) == 1
        assert method.paths[0][0] == 150.5
        assert method.terminal_summary.sample_std is None


def test_percentiles_probabilities_and_histogram_use_all_paths(rows):
    result, archive, _ = experiment(
        rows,
        replicas=137,
        horizon=8,
        display_paths=1,
        threshold="130",
        interval_low="90",
        interval_high="150",
    )
    with np.load(io.BytesIO(archive), allow_pickle=False) as matrices:
        for method in result.methods:
            full = matrices[method.method]
            assert len(method.paths) == 1 and sum(bin.frequency for bin in method.histogram) == 137
            assert sum(bin.relative_frequency for bin in method.histogram) == pytest.approx(1)
            for band in method.bands:
                assert band.p5 <= band.p25 <= band.median <= band.p75 <= band.p95
                assert band.mean == pytest.approx(float(np.mean(full[:, band.step])))
                assert band.p5 == pytest.approx(float(np.quantile(full[:, band.step], 0.05)))
            terminal = full[:, -1]
            for event in method.probabilities:
                assert 0 <= event.probability <= 1
                assert event.probability == event.count / 137
            by_event = {item.event: item for item in method.probabilities}
            assert by_event["above_threshold"].count == int(np.count_nonzero(terminal > 130))
            assert by_event["within_interval"].count == int(
                np.count_nonzero((terminal >= 90) & (terminal <= 150))
            )
            assert (
                sum(
                    by_event[name].count
                    for name in ["above_initial", "below_initial", "equal_initial"]
                )
                == 137
            )


def test_event_boundaries_are_strict_for_threshold_and_inclusive_for_interval():
    config = request(
        replicas=3, horizon=1, threshold="100", interval_low="100", interval_high="110"
    )
    result = summarize_paths(
        np.array([[100.0, 90.0], [100.0, 100.0], [100.0, 110.0]]), config, "bootstrap", 100, 100
    )
    events = {row["event"]: row for row in result["probabilities"]}
    assert events["above_threshold"]["count"] == events["below_threshold"]["count"] == 1
    assert events["equal_initial"]["count"] == 1
    assert events["within_interval"]["count"] == 2


def test_future_prices_never_enter_training_or_default_initial_price():
    records = sample([100, 110, 121, 9999])
    config = request(training_end="2024-01-03", cutoff_date="2024-01-03")
    first, _, selected = run_experiment(records, config, TODAY)
    second, _, _ = run_experiment(records[:3], config, TODAY)
    assert len(selected) == first.training.record_count == 3
    assert first.initial_price == 121 and first.training.last_date == date(2024, 1, 3)
    assert first.numeric_fingerprint == second.numeric_fingerprint


def test_gaps_excluded_without_interpolation():
    records = sample([100, 110, 121]) + sample([200, 220], "2024-01-06")
    result, _, _ = run_experiment(records, request(), TODAY)
    assert result.training.record_count == 5
    assert result.training.return_count == 3 and result.training.gap_count == 1
    assert any("huecos" in warning for warning in result.warnings)


@pytest.mark.parametrize("records", [[], sample([100]), sample([100, 110])])
def test_insufficient_training_rejected(records):
    with pytest.raises(SimulationError, match="dos rendimientos"):
        run_experiment(records, request(), TODAY)


def test_numerical_overflow_rejected_instead_of_clipped_or_nonfinite_prices():
    records = sample([0.01, 100, 1000000])
    with pytest.raises(SimulationError, match="rango numérico"):
        run_experiment(records, request(horizon=365, replicas=2), TODAY)


@pytest.mark.parametrize(
    "overrides",
    [
        {"training_start": "2024-02-01"},
        {"training_end": "2024-01-09"},
        {"method": "unknown"},
        {"horizon": 0},
        {"horizon": 366},
        {"replicas": 0},
        {"replicas": 50001},
        {"seed": -1},
        {"seed": 4294967296},
        {"seed": True},
        {"horizon": 1.5},
        {"replicas": "100"},
        {"initial_price": "0"},
        {"initial_price": "NaN"},
        {"threshold": "-1"},
        {"initial_price": "1.001"},
        {"interval_low": "100"},
        {"interval_high": "100"},
        {"interval_low": "110", "interval_high": "100"},
        {"horizon": 365, "replicas": 50000},
        {"display_paths": 51},
        {"unknown": True},
    ],
)
def test_invalid_and_abusive_parameters_rejected(overrides):
    with pytest.raises(ValidationError):
        request(**overrides)


@pytest.fixture
def client(imported, settings):
    with TestClient(create_app(settings), client=("127.0.0.1", 1234)) as client:
        yield client


def body(**overrides):
    return request(**overrides).model_dump(mode="json")


def test_api_persistence_retrieval_and_replay_from_immutable_snapshot(client, imported):
    before = data_status(imported)
    response = client.post("/api/v1/simulations", json=body())
    assert response.status_code == 201
    original = response.json()
    assert client.get("/api/v1/simulations/" + original["id"]).json() == original
    assert data_status(imported) == before
    with imported.connect() as connection:
        stored = connection.execute(
            "SELECT * FROM simulation_experiments WHERE id=?", (original["id"],)
        ).fetchone()
        assert len(json.loads(stored["snapshot_json"])) == 5
        with np.load(io.BytesIO(stored["paths_npz"]), allow_pickle=False) as paths:
            assert paths["monte_carlo"].shape == (100, 4)
        # Synthetic source revision after the experiment: replay must retain the saved training.
        connection.execute("DELETE FROM records")
    replay = client.post(f"/api/v1/simulations/{original['id']}/replay")
    assert replay.status_code == 201
    assert replay.json()["replay_of"] == original["id"]
    assert replay.json()["numeric_fingerprint"] == original["numeric_fingerprint"]
    assert replay.json()["methods"] == original["methods"]
    assert client.post("/api/v1/simulations", json=body()).status_code == 422


def test_api_no_external_requests_and_full_data_untouched(client, imported, monkeypatch):
    from app.source import SocrataClient

    def forbidden(*args, **kwargs):
        pytest.fail("La simulación debe funcionar sin internet")

    monkeypatch.setattr(SocrataClient, "request", forbidden)
    before = data_status(imported)
    assert client.post("/api/v1/simulations", json=body()).status_code == 201
    assert data_status(imported) == before


def test_api_future_cutoff_unknown_id_and_concurrency_protection(client):
    future = body(training_end="2024-01-08", cutoff_date="2099-01-01")
    assert client.post("/api/v1/simulations", json=future).status_code == 422
    id = "00000000-0000-0000-0000-000000000000"
    assert client.get("/api/v1/simulations/" + id).status_code == 404
    assert client.post(f"/api/v1/simulations/{id}/replay").status_code == 404
    assert client.get("/api/v1/simulations/invalid").status_code == 422
    with client.app.state.simulation_lock:
        assert client.post("/api/v1/simulations", json=body()).status_code == 429


def test_replay_rejects_a_different_numerical_environment(client, imported):
    original = client.post("/api/v1/simulations", json=body()).json()
    original["numpy_version"] = "different-version"
    with imported.connect() as connection:
        connection.execute(
            "UPDATE simulation_experiments SET result_json=? WHERE id=?",
            (json.dumps(original), original["id"]),
        )
    assert client.post(f"/api/v1/simulations/{original['id']}/replay").status_code == 422
