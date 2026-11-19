import csv
import io
from datetime import date, timedelta
from threading import Event

import httpx
import pytest

from app.banrep import BanrepClient, parse_csv
from app.records import DataError, audit_records, normalize
from app.source import SourceError, SyncCancelled
from app.sync import synchronize


def payload(values):
    stream = io.StringIO()
    writer = csv.DictWriter(
        stream,
        fieldnames=[
            "FREQ",
            "CURRENCY",
            "CURRENCY_DENOM",
            "EXR_TYPE",
            "EXR_SUFFIX",
            "UNIT_MULT",
            "OBS_STATUS",
            "TIME_PERIOD",
            "OBS_VALUE",
        ],
    )
    writer.writeheader()
    for day, value in values:
        writer.writerow(
            dict(
                FREQ="D",
                CURRENCY="COP",
                CURRENCY_DENOM="USD",
                EXR_TYPE="EN00",
                EXR_SUFFIX="A",
                UNIT_MULT="0",
                OBS_STATUS="A",
                TIME_PERIOD=day,
                OBS_VALUE=value,
            )
        )
    return stream.getvalue()


def test_daily_source_preserves_original_observations_and_zero_returns():
    # Saturday through Monday equal rates are a single observed validity. Tuesday
    # with the same rate is a new observation after an open Monday market.
    text = payload(
        [
            (f"2026-11-{d:02}", v)
            for d, v in [(6, "3990"), (7, "4000"), (8, "4000"), (9, "4000"), (10, "4000")]
        ]
    )
    rows = parse_csv(text)
    assert len(rows) == 3
    assert rows[1]["vigenciahasta"][:10] == "2026-11-09"
    assert len(rows[1]["observations"]) == 3
    assert rows[2]["valor"] == rows[1]["valor"]
    assert sum(len(r["observations"]) for r in rows) == 5


def test_sdmx_refresh_revalidates_old_records_even_when_incremental_requested(db, settings):
    values = [(str(date(2024, 1, 1) + timedelta(days=i)), str(4000 + i)) for i in range(40)]
    source = BanrepClient(
        settings,
        transport=httpx.MockTransport(lambda req: httpx.Response(200, text=payload(values))),
    )
    try:
        synchronize(db, settings, source, "full")
        # A remote correction outside the incremental lookback, including a
        # change in interval normalization, must not strand automatic refresh.
        values[0] = (values[0][0], "3999")
        result = synchronize(db, settings, source, "incremental")
        assert result["status"] == "success" and result["mode"] == "full"
        with db.connect() as connection:
            assert (
                connection.execute(
                    "SELECT value FROM records ORDER BY valid_from LIMIT 1"
                ).fetchone()[0]
                == "3999"
            )
        assert result["revised"] == 1
    finally:
        source.close()


def test_large_series_has_no_historical_limit_and_does_not_fill_missing_dates(settings):
    values = [(str(date(1991, 11, 27) + timedelta(days=i)), str(1000 + i)) for i in range(12000)]
    values.pop(100)
    source = BanrepClient(
        settings,
        transport=httpx.MockTransport(lambda req: httpx.Response(200, text=payload(values))),
    )
    rows, summary = source.download()
    source.close()
    assert len(rows) == summary["total"] == 11999
    audit = audit_records([normalize(r) for r in rows], date(2026, 11, 17))
    assert audit["gaps"] == audit["missing_days"] == 1
    assert len(audit["gap_ranges"]) == 1


@pytest.mark.parametrize(
    "values",
    [
        [("2026-11-01", "4000"), ("2026-11-01", "4000")],
        [("2026-11-01", "NaN")],
        [("2026-11-01", "0")],
        [("2026-02-30", "4000")],
        [("2026-11-01", "4000.001")],
    ],
)
def test_invalid_daily_observations_are_rejected(values):
    with pytest.raises(DataError):
        parse_csv(payload(values))


def test_remote_revision_during_download_does_not_replace_local_data(db, settings):
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, text=payload([("2026-11-17", str(4000 + len(calls)))]))

    source = BanrepClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceError, match="cambió"):
        synchronize(db, settings, source, "full")
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM records").fetchone()[0] == 0
    source.close()


def test_retry_and_retry_after_are_bounded(settings):
    calls, sleeps = [], []

    def handler(req):
        calls.append(req)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "2"})
        if len(calls) == 2:
            return httpx.Response(503)
        return httpx.Response(200, text=payload([("2026-11-17", "4000")]))

    settings.source_backoff_seconds = 1
    source = BanrepClient(settings, transport=httpx.MockTransport(handler), sleep=sleeps.append)
    assert source.summary()["total"] == 1
    assert sleeps == [2, 2]
    source.close()


@pytest.mark.parametrize("kind", ["network", "html", "client", "cooldown", "cancelled"])
def test_source_failure_does_not_create_data(settings, kind):
    calls = []

    def handler(req):
        calls.append(req)
        if kind == "network":
            raise httpx.ConnectError("Test-only network fault", request=req)
        if kind == "html":
            return httpx.Response(200, text="<html>unavailable</html>")
        return httpx.Response(429 if kind == "cooldown" else 403, headers={"Retry-After": "120"})

    source = BanrepClient(settings, transport=httpx.MockTransport(handler), sleep=lambda _: None)
    if kind == "cancelled":
        source.stop_event = Event()
        source.stop_event.set()
    with pytest.raises((SourceError, DataError, SyncCancelled)):
        source.download()
    assert len(calls) == (3 if kind == "network" else 0 if kind == "cancelled" else 1)
    source.close()
