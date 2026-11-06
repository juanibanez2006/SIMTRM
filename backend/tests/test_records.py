from datetime import date
from decimal import Decimal

import pytest
from conftest import synthetic_row

from app.records import DataError, audit_records, normalize


def test_monetary_precision_and_original_preserved():
    raw = synthetic_row("2024-01-01", "1234.50", "2024-01-03")
    row = normalize(raw)
    assert row.value == Decimal("1234.50")
    assert row.valid_from == date(2024, 1, 1)
    assert '"valor":"1234.50"' in row.raw_json
    assert row.fingerprint == normalize({**raw, "source_id": "changed-id"}).fingerprint


@pytest.mark.parametrize(
    "field,value",
    [
        ("valor", None),
        ("valor", 123.2),
        ("valor", "NaN"),
        ("valor", "Infinity"),
        ("valor", "0"),
        ("valor", "-10"),
        ("valor", "1.123"),
        ("unidad", "USD"),
        ("vigenciadesde", "invalid"),
        ("vigenciadesde", "2024-02-30"),
        ("vigenciadesde", "2024-01-02T01:00:00"),
        ("vigenciadesde", None),
    ],
)
def test_invalid_records_rejected(field, value):
    with pytest.raises(DataError):
        normalize({**synthetic_row("2024-01-01"), field: value})


def test_inverted_validity_rejected():
    with pytest.raises(DataError, match="invertida"):
        normalize(synthetic_row("2024-01-02", end="2024-01-01"))


def test_equal_prices_are_distinct_valid_observations(rows):
    result = audit_records([normalize(row) for row in rows], date(2024, 1, 8))
    assert result["duplicates"] == 0
    assert result["extended"] == 2
    assert result["gaps"] == result["overlaps"] == 0


@pytest.mark.parametrize(
    "extra,category",
    [
        (synthetic_row("2024-01-01"), "duplicates"),
        (synthetic_row("2024-01-01", "101"), "conflicts"),
        (synthetic_row("2024-01-02"), "overlaps"),
    ],
)
def test_duplicates_conflicts_and_overlaps(extra, category):
    first = synthetic_row("2024-01-01", end="2024-01-02" if category == "overlaps" else None)
    with pytest.raises(DataError) as caught:
        audit_records([normalize(first), normalize(extra)], date(2024, 1, 3))
    assert caught.value.audit[category] == 1


def test_gaps_extreme_changes_and_future_dates_are_flagged():
    records = [
        normalize(synthetic_row("2024-01-01")),
        normalize(synthetic_row("2024-01-04", "150", "2024-01-06")),
    ]
    audit = audit_records(records, date(2024, 1, 3))
    assert audit["gaps"] == audit["extreme_changes"] == audit["future_starts"] == 1
    assert audit["future_ends"] == 1
    assert len(records) == 2
