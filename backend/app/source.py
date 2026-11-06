import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from threading import Event

import httpx

from app.config import SOURCE_URL, Settings
from app.records import DataError, digest


class SourceError(RuntimeError):
    pass


class SyncCancelled(SourceError):
    pass


class SocrataClient:
    def __init__(self, settings: Settings, transport=None, sleep=time.sleep):
        self.settings = settings
        self.sleep = sleep
        self.stop_event: Event | None = None
        headers = {"Accept": "application/json", "User-Agent": "SIMTRM/0.1 academic"}
        if settings.socrata_app_token and settings.socrata_app_token.get_secret_value():
            headers["X-App-Token"] = settings.socrata_app_token.get_secret_value()
        self.client = httpx.Client(
            timeout=settings.source_timeout_seconds,
            headers=headers,
            transport=transport,
        )

    def close(self):
        self.client.close()

    def check_cancelled(self):
        if self.stop_event is not None and self.stop_event.is_set():
            raise SyncCancelled("Comprobación automática cancelada al cerrar el servidor")

    def request(self, params: dict) -> list:
        for attempt in range(self.settings.source_retries + 1):
            self.check_cancelled()
            response = None
            try:
                response = self.client.get(SOURCE_URL, params=params)
                self.check_cancelled()
                if response.status_code == 429 or response.status_code >= 500:
                    raise httpx.HTTPStatusError(
                        "Error transitorio", request=response.request, response=response
                    )
                response.raise_for_status()
                rows = response.json()
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise SourceError("La fuente no devolvió una lista JSON de registros")
                return rows
            except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                self.check_cancelled()
                transient = (
                    response is None or response.status_code == 429 or response.status_code >= 500
                )
                if not transient or attempt == self.settings.source_retries:
                    raise SourceError("No fue posible consultar Datos Abiertos Colombia") from exc
                delay = self.settings.source_backoff_seconds * 2**attempt
                retry_after = response.headers.get("Retry-After") if response is not None else None
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        try:
                            retry_date = parsedate_to_datetime(retry_after)
                            delay = max(delay, (retry_date - datetime.now(UTC)).total_seconds())
                        except (ValueError, TypeError):
                            pass
                # Long server cooldowns are surfaced; do not retry before Retry-After.
                if delay > 60:
                    raise SourceError(
                        "La fuente solicita una espera prolongada; inténtelo más tarde"
                    ) from exc
                if self.stop_event is None:
                    self.sleep(max(0, delay))
                else:
                    self.stop_event.wait(max(0, delay))
                    self.check_cancelled()
            except ValueError as exc:
                raise SourceError("La fuente devolvió JSON inválido") from exc
        raise SourceError("Se agotaron los reintentos")

    def summary(self, where: str | None = None) -> dict:
        params = {
            "$select": "count(*) as total,min(vigenciadesde) as first,"
            "max(vigenciahasta) as last,max(:updated_at) as updated"
        }
        if where:
            params["$where"] = where
        rows = self.request(params)
        try:
            if len(rows) != 1:
                raise ValueError
            total = int(rows[0]["total"])
            if total < 0:
                raise ValueError
            return {**rows[0], "total": total}
        except (ValueError, KeyError, TypeError) as exc:
            raise SourceError("Conteo remoto inválido") from exc

    def download(self, where: str | None = None) -> tuple[list[dict], dict]:
        before = self.summary(where)
        expected = before["total"]
        page_size = self.settings.source_page_size
        result = []
        fingerprints = set()
        source_ids = set()
        for offset in range(0, expected, page_size):
            params = {
                "$select": ":id as source_id,valor,unidad,vigenciadesde,vigenciahasta",
                "$limit": page_size,
                "$offset": offset,
                "$order": "vigenciadesde ASC, :id ASC",
            }
            if where:
                params["$where"] = where
            page = self.request(params)
            if len(page) != min(page_size, expected - offset):
                raise SourceError("Página incompleta: la descarga no se publicará")
            fingerprint = digest(page)
            if fingerprint in fingerprints:
                raise SourceError("La fuente repitió una página")
            fingerprints.add(fingerprint)
            for row in page:
                source_id = row.get("source_id")
                if not isinstance(source_id, str) or not source_id or source_id in source_ids:
                    raise DataError("Identificador remoto ausente o repetido", {"duplicates": 1})
                source_ids.add(source_id)
            result.extend(page)
        if len(result) != expected or self.summary(where) != before:
            raise SourceError(
                "El conjunto remoto cambió durante la descarga; repita la sincronización"
            )
        # Verify that offset order was respected; normalization validates actual dates later.
        dates = [row.get("vigenciadesde", "") for row in result]
        if dates != sorted(dates):
            raise SourceError("La fuente no respetó el orden temporal solicitado")
        return result, before
