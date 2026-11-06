import httpx
import pytest
from conftest import OfficialSourceDouble, synthetic_series

from app.records import DataError
from app.source import SocrataClient, SourceError


def test_pagination_has_stable_order_and_no_historical_cap(settings):
    official = OfficialSourceDouble(synthetic_series(5001))
    settings.source_page_size = 1000
    source = official.client(settings)
    rows, remote = source.download()
    source.close()
    assert len(rows) == remote["total"] == 5001
    pages = [query for query in official.queries if "$offset" in query]
    assert [int(query["$offset"]) for query in pages] == [0, 1000, 2000, 3000, 4000, 5000]
    assert all(query["$order"] == "vigenciadesde ASC, :id ASC" for query in pages)


def test_incomplete_page_rejected(settings, official):
    original = official.handler

    def handler(request):
        if request.url.params.get("$offset") == "2":
            return httpx.Response(200, json=[])
        return original(request)

    source = SocrataClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceError, match="incompleta"):
        source.download()
    source.close()


def test_repeated_page_rejected(settings, official):
    original = official.handler

    def handler(request):
        if request.url.params.get("$offset") == "2":
            return httpx.Response(200, json=official.rows[:2])
        return original(request)

    source = SocrataClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceError, match="repitió"):
        source.download()
    source.close()


def test_duplicate_remote_identifier_rejected(settings, official):
    official.rows[1]["source_id"] = official.rows[0]["source_id"]
    source = official.client(settings)
    with pytest.raises(DataError, match="repetido"):
        source.download()
    source.close()


def test_changed_remote_snapshot_rejected(settings, official):
    original = official.handler
    summaries = 0

    def handler(request):
        nonlocal summaries
        if "count(*)" in request.url.params.get("$select", ""):
            summaries += 1
            if summaries == 2:
                official.rows.pop()
        return original(request)

    source = SocrataClient(settings, transport=httpx.MockTransport(handler))
    with pytest.raises(SourceError, match="cambió"):
        source.download()
    source.close()


def test_retry_after_and_exponential_backoff(settings):
    attempts, sleeps = [], []

    def handler(request):
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(429, headers={"Retry-After": "2"})
        if len(attempts) == 2:
            return httpx.Response(503)
        return httpx.Response(200, json=[])

    settings.source_backoff_seconds = 1
    source = SocrataClient(settings, transport=httpx.MockTransport(handler), sleep=sleeps.append)
    assert source.request({}) == []
    assert sleeps == [2, 2]
    source.close()


@pytest.mark.parametrize("kind", ["network", "json", "object", "client-error", "long-cooldown"])
def test_source_failures_surface_without_internal_details(settings, kind):
    attempts = []

    def handler(request):
        attempts.append(1)
        if kind == "network":
            raise httpx.ConnectError("Synthetic network failure", request=request)
        if kind == "json":
            return httpx.Response(200, text="<html>bad</html>")
        if kind == "object":
            return httpx.Response(200, json={"error": "bad"})
        if kind == "long-cooldown":
            return httpx.Response(429, headers={"Retry-After": "120"})
        return httpx.Response(400)

    source = SocrataClient(settings, transport=httpx.MockTransport(handler), sleep=lambda _: None)
    with pytest.raises(SourceError):
        source.request({})
    assert len(attempts) == (3 if kind == "network" else 1)
    source.close()
