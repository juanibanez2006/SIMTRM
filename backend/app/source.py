import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from threading import Event
from typing import Protocol

import httpx

from app.config import SOURCE_URL, Settings


class SourceError(RuntimeError):
    pass


class SyncCancelled(SourceError):
    pass


class HistoricalSource(Protocol):
    def summary(self, where: str | None = None) -> dict: ...
    def download(self, where: str | None = None) -> tuple[list[dict], dict]: ...
    def check_cancelled(self): ...
    def close(self): ...


class HttpSource:
    def __init__(self, settings: Settings, transport=None, sleep=time.sleep):
        self.settings, self.sleep = settings, sleep
        self.stop_event: Event | None = None
        self.client = httpx.Client(
            timeout=settings.source_timeout_seconds,
            transport=transport,
            trust_env=settings.source_trust_env,
            headers={"Accept": "text/csv", "User-Agent": "SIMTRM/1.0"},
        )

    def close(self):
        self.client.close()

    def check_cancelled(self):
        if self.stop_event is not None and self.stop_event.is_set():
            raise SyncCancelled("Actualización cancelada al cerrar el servidor")

    def request(self, params: dict) -> httpx.Response:
        for attempt in range(self.settings.source_retries + 1):
            self.check_cancelled()
            try:
                response = self.client.get(SOURCE_URL, params=params)
                response.raise_for_status()
                self.check_cancelled()
                return response
            except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                transient = (
                    not isinstance(exc, httpx.HTTPStatusError)
                    or exc.response.status_code == 429
                    or exc.response.status_code >= 500
                )
                if not transient or attempt == self.settings.source_retries:
                    raise SourceError("No fue posible consultar el Banco de la República") from exc
                delay = self.settings.source_backoff_seconds * 2**attempt
                if isinstance(exc, httpx.HTTPStatusError):
                    value = exc.response.headers.get("Retry-After")
                    if value:
                        try:
                            cooldown = float(value)
                        except ValueError:
                            try:
                                parsed = parsedate_to_datetime(value)
                                cooldown = (parsed - datetime.now(UTC)).total_seconds()
                            except (ValueError, TypeError):
                                cooldown = 0
                        delay = max(delay, cooldown)
                if delay > 60:
                    raise SourceError(
                        "La fuente solicita una espera prolongada; inténtelo más tarde"
                    ) from exc
                if self.stop_event is None:
                    self.sleep(max(0, delay))
                else:
                    self.stop_event.wait(max(0, delay))
        raise SourceError("Se agotaron los reintentos")
