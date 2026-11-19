"""Official SDMX 3.0 TRM daily series, preserving all original observations."""

import csv
import io
from datetime import date, timedelta

from app.config import SOURCE_URL
from app.records import DataError, digest, normalize
from app.source import HttpSource, SourceError
from app.trm_calendar import market_day


def parse_csv(payload: str) -> list[dict]:
    observations = list(csv.DictReader(io.StringIO(payload.lstrip("\ufeff"))))
    if not observations:
        raise SourceError("El Banco de la República no devolvió observaciones")
    daily, seen = [], set()
    for obs in observations:
        try:
            if any(
                obs[k] != v
                for k, v in {
                    "FREQ": "D",
                    "CURRENCY": "COP",
                    "CURRENCY_DENOM": "USD",
                    "EXR_TYPE": "EN00",
                    "EXR_SUFFIX": "A",
                    "UNIT_MULT": "0",
                }.items()
            ):
                raise ValueError("Serie o unidad inesperada")
            if obs.get("OBS_STATUS") != "A":
                raise ValueError("La observación no tiene estado normal A")
            day = date.fromisoformat(obs["TIME_PERIOD"])
            if day in seen:
                raise ValueError(f"Fecha duplicada: {day}")
            seen.add(day)
            raw = dict(
                valor=obs["OBS_VALUE"],
                unidad="COP",
                vigenciadesde=f"{day}T00:00:00",
                vigenciahasta=f"{day}T00:00:00",
                source_id=f"DF_TRM:{day}",
                _source=SOURCE_URL,
                observations=[obs],
            )
            normalize(raw)
            daily.append(raw)
        except (KeyError, ValueError, DataError) as exc:
            raise DataError(f"Observación SDMX inválida: {exc}", {"rejected": 1}) from exc
    daily.sort(key=lambda r: r["vigenciadesde"])
    records = []
    for raw in daily:
        day = date.fromisoformat(raw["vigenciadesde"][:10])
        previous = records[-1] if records else None
        # Combine only OBSERVED equal rates across an expected closed market day.
        # Equal rates after an open market day remain separate transitions.
        if (
            previous
            and previous["vigenciahasta"][:10] == str(day - timedelta(days=1))
            and normalize(previous).value == normalize(raw).value
            and not market_day(day - timedelta(days=1), day)
        ):
            previous["vigenciahasta"] = raw["vigenciahasta"]
            previous["observations"].extend(raw["observations"])
        else:
            records.append(raw)
    return records


class BanrepClient(HttpSource):
    """Reuse bounded HTTP retries and cancellation; expose the sync snapshot contract."""

    url = SOURCE_URL
    complete_snapshot = True

    def __init__(self, settings, transport=None, **kwargs):
        super().__init__(settings, transport=transport, **kwargs)
        self._records: list[dict] | None = None

    def _fetch(self):
        response = self.request({"format": "csv"})
        self._records = parse_csv(response.text)

    def _select(self, where):
        rows = self._records or []
        if where:
            since = where.split("'")[1][:10]
            rows = [r for r in rows if r["vigenciahasta"][:10] >= since]
        return rows

    @staticmethod
    def _summary(rows):
        return dict(
            total=len(rows),
            first=rows[0]["vigenciadesde"] if rows else None,
            last=rows[-1]["vigenciahasta"] if rows else None,
            updated=digest(rows),
        )

    def summary(self, where=None):
        self._fetch()
        return self._summary(self._select(where))

    def download(self, where=None):
        if self._records is None:
            self._fetch()
        rows = self._select(where)
        return rows, self._summary(rows)
