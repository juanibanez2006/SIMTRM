import math
import statistics
from datetime import date, timedelta

import pytest
from conftest import synthetic_row, synthetic_series
from fastapi.testclient import TestClient

from app.comparison import compare_records
from app.main import create_app
from app.queries import data_status
from app.records import DataError, normalize
from app.schemas import ComparisonOut, ComparisonQuery


def sample(start, values):
    return [
        normalize(synthetic_row(str(date.fromisoformat(start) + timedelta(days=index)), str(value)))
        for index, value in enumerate(values)
    ]


def comparison(a=None, b=None, alignment="observation", **overrides):
    a = sample("2024-01-01", [100, 110, 120]) if a is None else a
    b = sample("2024-02-01", [200, 220, 242, 266.2]) if b is None else b
    query = ComparisonQuery(
        **{
            "a_start": "2024-01-01",
            "a_end": "2024-01-31",
            "b_start": "2024-02-01",
            "b_end": "2024-02-29",
            "alignment": alignment,
            **overrides,
        }
    )
    return compare_records(a, b, query, date(2026, 11, 5))


def test_known_normalization_indicators_differences_and_unequal_lengths():
    result = comparison()
    a, b = result["a"], result["b"]
    assert [p["normalized"] for p in a["points"]] == [100, 110, 120]
    assert [p["normalized"] for p in b["points"]] == pytest.approx([100, 110, 121, 133.1])
    assert a["metrics"]["mean"] == a["metrics"]["median"] == 110
    assert a["metrics"]["sample_std"] == 10
    assert b["metrics"]["mean"] == pytest.approx(232.05)
    assert a["metrics"]["absolute_change"] == 20
    assert b["metrics"]["absolute_change"] == pytest.approx(66.2)
    assert (
        a["metrics"]["relative_change"] == a["metrics"]["cumulative_return"] == pytest.approx(0.2)
    )
    assert b["metrics"]["cumulative_return"] == pytest.approx(0.331)
    logs = [math.log(110 / 100), math.log(120 / 110)]
    assert a["metrics"]["volatility"] == pytest.approx(statistics.stdev(logs))
    differences = {row["metric"]: row for row in result["differences"]}
    assert differences["mean"]["delta"] == pytest.approx(122.05)
    assert differences["mean"]["relative_delta"] == pytest.approx(232.05 / 110 - 1)
    assert differences["relative_change"]["delta"] == pytest.approx(0.131)
    assert differences["relative_change"]["relative_delta"] is None
    assert result["paired_positions"] == 3
    assert len(result["rows"]) == 4 and result["rows"][-1]["a"] is None
    ComparisonOut.model_validate(result)


def test_alignment_does_not_change_data_or_statistics():
    observation = comparison()
    elapsed = comparison(alignment="elapsed_days")
    for id in ["a", "b"]:
        assert observation[id]["metrics"] == elapsed[id]["metrics"]
        assert observation[id]["dataset_fingerprint"] == elapsed[id]["dataset_fingerprint"]
        assert [point["normalized"] for point in observation[id]["points"]] == [
            point["normalized"] for point in elapsed[id]["points"]
        ]
    assert observation["a"]["points"][0]["position"] == 1
    assert elapsed["a"]["points"][0]["position"] == 0
    assert observation["dataset_fingerprint"] == elapsed["dataset_fingerprint"]


def test_leap_day_and_calendar_alignment_use_actual_days():
    a = sample("2024-02-28", [100, 110, 120])
    b = sample("2023-02-28", [200, 220])
    result = comparison(
        a,
        b,
        "elapsed_days",
        a_start="2024-02-28",
        a_end="2024-03-01",
        b_start="2023-02-28",
        b_end="2023-03-01",
    )
    assert [point["position"] for point in result["a"]["points"]] == [0, 1, 2]
    assert [point["date"] for point in result["a"]["points"]][1] == "2024-02-29"
    assert [point["position"] for point in result["b"]["points"]] == [0, 1]
    assert result["rows"][-1]["b"] is None


def test_extended_validity_clipped_visually_without_adding_observations():
    a = [
        normalize(synthetic_row("2023-12-29", "100", "2024-01-01")),
        normalize(synthetic_row("2024-01-02", "110", "2024-01-04")),
    ]
    result = comparison(a=a, alignment="elapsed_days", a_end="2024-01-03")
    assert result["a"]["metrics"]["count"] == 2
    assert result["a"]["return_count"] == 1
    assert [point["position"] for point in result["a"]["points"]] == [0, 1]
    assert result["a"]["points"][0]["date"] == "2023-12-29"
    assert result["a"]["points"][0]["effective_date"] == "2024-01-01"
    assert result["a"]["points"][-1]["effective_until"] == "2024-01-03"
    assert result["a"]["points"][-1]["valid_to"] == "2024-01-04"


def test_calendar_positions_do_not_shift_to_fill_missing_start():
    result = comparison(a=sample("2024-01-04", [100, 110]), alignment="elapsed_days")
    assert [point["position"] for point in result["a"]["points"]] == [3, 4]
    assert result["a"]["points"][0]["normalized"] == 100
    assert result["rows"][0]["a"] is None and result["rows"][0]["position"] == 0


def test_gaps_disable_cumulative_return_but_preserve_endpoint_change():
    a = [
        normalize(synthetic_row("2024-01-01", "100")),
        normalize(synthetic_row("2024-01-04", "121")),
    ]
    result = comparison(a=a)
    assert result["a"]["metrics"]["relative_change"] == pytest.approx(0.21)
    assert result["a"]["metrics"]["cumulative_return"] is None
    assert result["a"]["metrics"]["volatility"] is None
    assert result["a"]["points"][1]["gap_before"]
    assert result["a"]["gap_count"] == 1
    assert result["a"]["return_count"] == 0


def test_equal_prices_and_zero_baseline_dispersion_are_valid():
    result = comparison(a=sample("2024-01-01", [100, 100, 100]))
    assert result["a"]["metrics"]["count"] == 3 and result["a"]["return_count"] == 2
    assert result["a"]["metrics"]["sample_std"] == result["a"]["metrics"]["volatility"] == 0
    assert result["a"]["metrics"]["cumulative_return"] == 0
    std = next(row for row in result["differences"] if row["metric"] == "sample_std")
    assert std["relative_delta"] is None


@pytest.mark.parametrize(
    "a,b", [([], []), ([], sample("2024-02-01", [200])), (sample("2024-01-01", [100]), [])]
)
def test_empty_or_singleton_periods_are_explicit(a, b):
    result = comparison(a, b)
    for id, records in [("a", a), ("b", b)]:
        assert result[id]["metrics"]["count"] == len(records)
        assert result[id]["metrics"]["absolute_change"] is None
        assert result[id]["metrics"]["relative_change"] is None
        assert result[id]["metrics"]["sample_std"] is None
        assert result[id]["metrics"]["volatility"] is None
        if records:
            assert result[id]["points"][0]["normalized"] == 100
        else:
            assert result[id]["metrics"]["mean"] is None
    assert all(row["delta"] is None for row in result["differences"] if row["metric"] != "count")
    ComparisonOut.model_validate(result)


def test_same_period_has_zero_differences_and_overlap_warning():
    a = sample("2024-01-01", [100, 110, 120])
    result = comparison(a, a, b_start="2024-01-01", b_end="2024-01-31")
    assert all(row["delta"] == 0 for row in result["differences"])
    assert any("solapan" in warning for warning in result["warnings"])


def test_future_values_excluded_and_partial_period_flagged():
    a = sample("2026-11-04", [100, 110, 120])
    result = comparison(a=a, a_start="2026-11-01", a_end="2026-11-30")
    assert result["a"]["metrics"]["count"] == 2
    assert result["a"]["excluded_future_records"] == 1
    assert result["a"]["observed_end"] == "2026-11-05"
    assert any("corte" in warning for warning in result["a"]["warnings"])


def test_duplicate_records_still_rejected_by_shared_validation():
    a = sample("2024-01-01", [100]) * 2
    with pytest.raises(DataError):
        comparison(a=a)


def test_large_comparison_uses_every_record():
    records = [normalize(row) for row in synthetic_series(5001)]
    result = comparison(
        records,
        records,
        a_start="2000-01-01",
        a_end="2026-11-05",
        b_start="2000-01-01",
        b_end="2026-11-05",
    )
    assert (
        result["a"]["metrics"]["count"]
        == result["b"]["metrics"]["count"]
        == len(result["rows"])
        == 5001
    )
    assert result["a"]["points"][-1]["normalized"] == 5100


@pytest.fixture
def client(imported, settings):
    with TestClient(create_app(settings)) as client:
        yield client


BASE = (
    "/api/v1/trm/comparison?a_start=2024-01-01&a_end=2024-01-08&b_start=2024-01-02&b_end=2024-01-07"
)


def test_api_matches_statistics_and_never_contacts_external_source(client, imported, monkeypatch):
    from app.source import SocrataClient

    before = data_status(imported)

    def forbidden(*args, **kwargs):
        pytest.fail("La comparación debe funcionar sin consultar internet")

    monkeypatch.setattr(SocrataClient, "request", forbidden)
    response = client.get(BASE)
    assert response.status_code == 200
    result = ComparisonOut.model_validate(response.json())
    stats = client.get("/api/v1/trm/statistics?start=2024-01-01&end=2024-01-08").json()
    assert result.a.metrics.mean == stats["summary"]["mean"]
    assert result.a.metrics.sample_std == stats["summary"]["sample_std"]
    assert result.a.metrics.volatility == stats["volatility"]["historical"]
    assert result.a.dataset_fingerprint == stats["dataset_fingerprint"]
    assert result.b.metrics.count == 3
    assert data_status(imported) == before


@pytest.mark.parametrize(
    "suffix",
    [
        "&alignment=invalid",
        "&unknown=1",
        "&a_start=bad",
        "&a_start=2024-02-01",
        "&b_end=2024-01-01",
    ],
)
def test_invalid_query_rejected(client, suffix):
    # Rebuild duplicated keys to test the actual supplied final parameter value.
    from urllib.parse import parse_qsl, urlencode

    params = dict(parse_qsl(BASE.split("?")[1] + suffix))
    response = client.get("/api/v1/trm/comparison?" + urlencode(params))
    assert response.status_code == 422 and response.json()["error"]["code"] == 422


def test_required_dates_and_empty_database_are_handled(settings):
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/trm/comparison").status_code == 422
        response = client.get(BASE)
        assert response.status_code == 200
        assert response.json()["rows"] == [] and "NaN" not in response.text
        assert "/api/v1/trm/comparison" in client.get("/openapi.json").json()["paths"]
