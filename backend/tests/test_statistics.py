import math
from dataclasses import replace
from datetime import date
from decimal import Decimal

import numpy as np
import pytest
from conftest import synthetic_row, synthetic_series
from fastapi.testclient import TestClient

from app.main import create_app
from app.queries import data_status
from app.records import DataError, normalize
from app.schemas import StatisticsOut, StatisticsQuery
from app.statistics import analyze_records, describe, distribution


def analyze(rows, variable="price", **kwargs):
    return analyze_records(
        [normalize(row) for row in rows],
        StatisticsQuery(variable=variable, **kwargs),
        date(2026, 11, 5),
    )


def test_descriptive_statistics_against_analytic_sample():
    result = describe(np.array([1.0, 2.0, 3.0, 4.0, 5.0]), "price")
    assert result["count"] == 5
    assert result["mean"] == result["median"] == 3
    assert result["minimum"] == 1 and result["maximum"] == 5 and result["range"] == 4
    assert result["population_variance"] == 2
    assert result["sample_variance"] == 2.5
    assert result["sample_std"] == pytest.approx(math.sqrt(2.5))
    assert result["q1"] == 2 and result["q3"] == 4 and result["iqr"] == 2
    assert result["percentiles"] == pytest.approx(
        {"p5": 1.2, "p25": 2.0, "p50": 3.0, "p75": 4.0, "p95": 4.8}
    )
    assert result["coefficient_variation_pct"] == pytest.approx(math.sqrt(2.5) / 3 * 100)


@pytest.mark.parametrize("values", [[], [7.0], [7.0, 7.0, 7.0]])
def test_empty_singleton_and_constant_samples(values):
    summary = describe(np.array(values), "price")
    assert summary["count"] == len(values)
    assert summary["sample_std"] == (0 if len(values) > 1 else None)
    assert summary["sample_variance"] == (0 if len(values) > 1 else None)
    assert summary["population_variance"] == (0 if values else None)
    if not values:
        assert summary["mean"] is None and summary["percentiles"] == {}


@pytest.mark.parametrize("values", [[np.nan], [np.inf], [-np.inf], [[1, 2]]])
def test_nonfinite_or_nonvector_samples_rejected(values):
    with pytest.raises(ValueError, match="vector"):
        describe(np.array(values), "price")


@pytest.mark.parametrize("variable", ["simple_return", "log_return"])
def test_cv_not_reported_for_returns(variable):
    for values in [[-0.1, 0, 0.1], [-0.2, -0.1], [0.1, 0.2]]:
        assert describe(np.array(values), variable)["coefficient_variation_pct"] is None


def test_returns_known_ratios_equal_prices_and_extended_validity(rows):
    result = analyze(rows, "simple_return", rolling_window=2)
    returns = result["returns"]
    assert len(returns) == result["summary"]["count"] == 4
    expected = [0.1, 0, 0.1, -1 / 121]
    assert [row["simple_return"] for row in returns] == pytest.approx(expected)
    assert [row["absolute_change"] for row in returns] == [10, 0, 11, -1]
    assert [row["elapsed_calendar_days"] for row in returns] == [4, 1, 1, 4]
    for row in returns:
        assert math.expm1(row["log_return"]) == pytest.approx(row["simple_return"], abs=1e-15)
    assert result["record_count"] == 5 and result["extended_records"] == 2
    assert result["volatility"]["annualized"] is None
    logs = [math.log1p(x) for x in expected]
    mean = sum(logs) / 4
    known_std = math.sqrt(sum((x - mean) ** 2 for x in logs) / 3)
    assert result["volatility"]["historical"] == pytest.approx(known_std)
    assert result["volatility"]["points"][0]["value"] is None
    assert result["volatility"]["points"][1]["value"] == pytest.approx(
        abs(logs[1] - logs[0]) / math.sqrt(2)
    )


def test_log_return_numerical_stability_for_extreme_valid_price_ratio():
    rows = [synthetic_row("2024-01-01", "1000000000.00"), synthetic_row("2024-01-02", "0.01")]
    result = analyze(rows, "log_return")
    assert result["points"][0]["value"] == pytest.approx(math.log(1e-11), abs=1e-13)


def test_zero_volatility_and_retained_zero_returns():
    rows = [synthetic_row(f"2024-01-0{index}", "100") for index in range(1, 5)]
    result = analyze(rows, "log_return", rolling_window=2)
    assert result["summary"]["count"] == 3
    assert result["summary"]["sample_std"] == result["volatility"]["historical"] == 0
    assert [row["value"] for row in result["volatility"]["points"]] == [None, 0, 0]


def test_gaps_excluded_and_rolling_window_resets():
    rows = [
        synthetic_row("2024-01-01", "100"),
        synthetic_row("2024-01-02", "110"),
        synthetic_row("2024-01-05", "121"),
        synthetic_row("2024-01-06", "133.10"),
        synthetic_row("2024-01-07", "146.41"),
    ]
    result = analyze(rows, "log_return", rolling_window=2)
    assert result["excluded_gap_pairs"] == 1
    assert result["summary"]["count"] == 3
    assert result["returns"][1]["excluded_gap"] and result["returns"][1]["log_return"] is None
    assert [row["value"] for row in result["volatility"]["points"]][:3] == [None, None, None]
    assert result["volatility"]["points"][-1]["value"] == pytest.approx(0, abs=1e-14)
    assert result["points"][1]["value"] is None
    prices = analyze(rows)
    assert prices["summary"]["count"] == 5 and len(prices["points"]) == 6
    assert prices["points"][2]["value"] is None


def test_future_observations_excluded_and_fingerprinted():
    rows = [
        synthetic_row("2026-11-04", "100"),
        synthetic_row("2026-11-05", "110"),
        synthetic_row("2026-11-06", "120"),
    ]
    result = analyze(rows)
    assert result["record_count"] == 2 and result["excluded_future_records"] == 1
    assert result["summary"]["mean"] == 105
    assert result["dataset_fingerprint"] == analyze(rows[:2])["dataset_fingerprint"]
    assert result["last_date"] == "2026-11-05"


@pytest.mark.parametrize("value", [Decimal(0), Decimal(-1), Decimal("NaN"), Decimal("Infinity")])
def test_invalid_prices_rejected_before_calculation(value):
    records = [replace(normalize(synthetic_row("2024-01-01")), value=value)]
    with pytest.raises(DataError):
        analyze_records(records, StatisticsQuery(), date(2026, 11, 5))


def test_histogram_frequencies_ecdf_ties_and_rightmost_inclusion():
    values = np.array([0.0, 0.0, 1.0, 2.0, 4.0])
    histogram, ecdf, _, method = distribution(values, 2)
    assert "2 clases" in method
    assert [row["frequency"] for row in histogram] == [3, 2]
    assert sum(row["frequency"] for row in histogram) == 5
    assert sum(row["relative_frequency"] for row in histogram) == pytest.approx(1)
    assert [row["cumulative_frequency"] for row in histogram] == [3, 5]
    assert histogram[-1]["right_closed"] and histogram[-1]["cumulative_probability"] == 1
    assert not histogram[0]["right_closed"]
    assert ecdf[0] == {"value": 0, "probability": 0.4, "cumulative_count": 2}
    assert [row["probability"] for row in ecdf] == [0.4, 0.6, 0.8, 1.0]


def test_boxplot_tukey_whiskers_and_outliers_remain_in_sample():
    values = np.array([1.0, 2.0, 3.0, 4.0, 100.0])
    histogram, _, box, _ = distribution(values, None)
    assert box["whisker_low"] == 1 and box["whisker_high"] == 4
    assert box["outliers"] == [100] and box["outlier_count"] == 1
    assert sum(row["frequency"] for row in histogram) == 5
    assert describe(values, "price")["mean"] == 22


@pytest.mark.parametrize("values", [[0.0], [0.0, 0.0, 0.0], [-1.0, -1.0]])
def test_constant_distribution_is_finite(values):
    histogram, ecdf, box, _ = distribution(np.array(values), 20)
    assert len(histogram) == 1 and histogram[0]["frequency"] == len(values)
    assert histogram[0]["lower"] < values[0] < histogram[0]["upper"]
    assert len(ecdf) == 1 and ecdf[0]["probability"] == 1
    assert box["outlier_count"] == 0


def test_large_sample_not_truncated_and_percentiles_ordered():
    result = analyze(synthetic_series(5001))
    assert result["summary"]["count"] == len(result["points"]) == 5001
    assert sum(row["frequency"] for row in result["histogram"]) == 5001
    assert result["summary"]["mean"] == 2600
    quantiles = list(result["summary"]["percentiles"].values())
    assert quantiles == sorted(quantiles)
    assert all(0 <= row["probability"] <= 1 for row in result["ecdf"])
    StatisticsOut.model_validate(result)


@pytest.fixture
def client(imported, settings):
    with TestClient(create_app(settings)) as client:
        yield client


def test_api_statistics_same_filtered_population_and_no_external_dependency(client, monkeypatch):
    from app.source import SocrataClient

    def forbid_external(*args, **kwargs):
        pytest.fail("El análisis estadístico no debe consultar la API externa")

    monkeypatch.setattr(SocrataClient, "request", forbid_external)
    response = client.get("/api/v1/trm/statistics?year=2024&variable=price")
    assert response.status_code == 200
    result = StatisticsOut.model_validate(response.json())
    assert result.record_count == result.summary.count == 5
    assert result.summary.mean == pytest.approx(112.2)
    assert result.filters.year == 2024
    assert (
        result.dataset_fingerprint
        == client.get("/api/v1/data/status").json()["dataset_fingerprint"]
    )


def test_returns_never_borrow_an_observation_outside_filter(client):
    result = client.get(
        "/api/v1/trm/statistics?start=2024-01-03&end=2024-01-04&variable=simple_return"
    ).json()
    assert result["record_count"] == 2 and result["summary"]["count"] == 1
    assert result["returns"][0]["from_date"] == "2024-01-03"
    assert result["summary"]["mean"] == pytest.approx(0.1)
    day = client.get(
        "/api/v1/trm/statistics?start=2024-01-06&end=2024-01-06&variable=log_return"
    ).json()
    assert day["record_count"] == 1 and day["summary"]["count"] == 0
    assert day["volatility"]["historical"] is None
    assert day["histogram"] == [] and day["boxplot"] is None


def test_empty_filter_has_no_nan_and_does_not_modify_dataset(client, imported):
    before = data_status(imported)
    response = client.get("/api/v1/trm/statistics?year=2025")
    assert response.status_code == 200 and "NaN" not in response.text
    result = response.json()
    assert result["summary"]["count"] == 0 and result["summary"]["mean"] is None
    assert result["volatility"]["historical"] is None
    assert result["first_date"] is None
    assert data_status(imported) == before


@pytest.mark.parametrize(
    "query",
    [
        "variable=invalid",
        "bins=0",
        "bins=81",
        "rolling_window=1",
        "rolling_window=253",
        "year=2024&month=13",
        "month=1",
        "start=2025-01-01&end=2024-01-01",
        "unknown=1",
    ],
)
def test_invalid_statistics_inputs_use_consistent_errors(client, query):
    response = client.get("/api/v1/trm/statistics?" + query)
    assert response.status_code == 422 and response.json()["error"]["code"] == 422


def test_api_histogram_options_and_openapi(client):
    result = client.get("/api/v1/trm/statistics?bins=5&rolling_window=2&variable=log_return").json()
    assert result["variable"] == "log_return" and len(result["histogram"]) == 5
    assert result["volatility"]["rolling_window"] == 2
    assert "/api/v1/trm/statistics" in client.get("/openapi.json").json()["paths"]
