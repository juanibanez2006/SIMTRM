from datetime import date, timedelta

import httpx
import pytest

from app.config import Settings
from app.db import Database
from app.source import SocrataClient


def synthetic_row(start: str, value="100.00", end=None, source_id=None):
    return {
        "source_id": source_id or f"synthetic-{start}",
        "valor": value,
        "unidad": "COP",
        "vigenciadesde": start + "T00:00:00.000",
        "vigenciahasta": (end or start) + "T00:00:00.000",
    }


def synthetic_series(size):
    return [
        synthetic_row(str(date(2000, 1, 1) + timedelta(days=index)), str(100 + index))
        for index in range(size)
    ]


@pytest.fixture
def rows():
    # All synthetic values are confined to tests.
    return [
        synthetic_row("2023-12-29", "100.00", "2024-01-01"),
        synthetic_row("2024-01-02", "110.00"),
        synthetic_row("2024-01-03", "110.00"),
        synthetic_row("2024-01-04", "121.00", "2024-01-07"),
        synthetic_row("2024-01-08", "120.00"),
    ]


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        auto_sync_enabled=False,
        database_path=tmp_path / "test.sqlite3",
        source_page_size=2,
        source_backoff_seconds=0,
        source_retries=2,
        sync_lookback_days=3,
    )


@pytest.fixture
def db(settings):
    database = Database(settings.database_path)
    database.initialize()
    return database


class OfficialSourceDouble:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []
        self.failure = None

    def handler(self, request):
        self.queries.append(dict(request.url.params))
        if self.failure:
            return httpx.Response(self.failure)
        params = request.url.params
        rows = self.rows
        where = params.get("$where")
        if where:
            since = where.split("'")[1][:10]
            rows = [row for row in rows if row["vigenciahasta"][:10] >= since]
        if "count(*)" in params.get("$select", ""):
            return httpx.Response(
                200,
                json=[
                    {
                        "total": str(len(rows)),
                        "first": min((row["vigenciadesde"] for row in rows), default=None),
                        "last": max((row["vigenciahasta"] for row in rows), default=None),
                        "updated": "2024-01-01T00:00:00.000Z",
                    }
                ],
            )
        offset, limit = int(params.get("$offset", 0)), int(params.get("$limit", 1000))
        return httpx.Response(200, json=rows[offset : offset + limit])

    def client(self, settings):
        return SocrataClient(
            settings, transport=httpx.MockTransport(self.handler), sleep=lambda _: None
        )


@pytest.fixture
def official(rows):
    return OfficialSourceDouble(rows)


@pytest.fixture
def imported(db, settings, official):
    from app.sync import synchronize

    source = official.client(settings)
    try:
        synchronize(db, settings, source, "full")
    finally:
        source.close()
    return db
