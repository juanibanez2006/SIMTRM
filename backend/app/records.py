import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from app.config import SOURCE_URL


class DataError(ValueError):
    def __init__(self, message: str, audit: dict | None = None):
        super().__init__(message)
        self.audit = audit or {}


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Record:
    value: Decimal
    valid_from: date
    valid_to: date
    source_id: str | None
    fingerprint: str
    raw_json: str

    def storage(self, obtained_at: str) -> tuple:
        return (
            format(self.value, "f"),
            "COP",
            self.valid_from.isoformat(),
            self.valid_to.isoformat(),
            self.source_id,
            self.fingerprint,
            SOURCE_URL,
            obtained_at,
            "validated",
            self.raw_json,
        )


def parse_date(value) -> date:
    if not isinstance(value, str):
        raise ValueError("Fecha ausente o inválida")
    parsed = datetime.fromisoformat(value)
    if parsed.time().isoformat() != "00:00:00" or parsed.tzinfo is not None:
        raise ValueError("Se esperaba una fecha de vigencia sin hora ni zona")
    return parsed.date()


def normalize(raw: dict) -> Record:
    try:
        if not isinstance(raw, dict) or not isinstance(raw.get("valor"), str):
            raise ValueError("El valor monetario debe ser una cadena decimal")
        value = Decimal(raw["valor"])
        if not value.is_finite() or value <= 0 or value > Decimal("1000000000"):
            raise ValueError("TRM no positiva, no finita o fuera del rango admitido")
        # Reject rather than silently round a changed monetary precision.
        if value != value.quantize(Decimal("0.01")):
            raise ValueError("Precisión monetaria mayor a dos decimales")
        if raw["unidad"] != "COP":
            raise ValueError("Unidad diferente de COP")
        start = parse_date(raw["vigenciadesde"])
        end = parse_date(raw["vigenciahasta"])
        if start > end:
            raise ValueError("Vigencia invertida")
        identity = [format(value.quantize(Decimal("0.01")), "f"), "COP", str(start), str(end)]
        return Record(
            value, start, end, raw.get("source_id"), digest(identity), canonical_json(raw)
        )
    except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
        raise DataError(f"Registro inválido: {exc}", {"rejected": 1, "sample": raw}) from exc


def audit_records(records: list[Record], today: date) -> dict:
    records = sorted(records, key=lambda item: item.valid_from)
    audit = {
        "rejected": 0,
        "duplicates": 0,
        "conflicts": 0,
        "overlaps": 0,
        "gaps": 0,
        "extended": 0,
        "future_starts": 0,
        "future_ends": 0,
        "extreme_changes": 0,
    }
    previous = None
    for item in records:
        audit["extended"] += int(item.valid_to > item.valid_from)
        audit["future_starts"] += int(item.valid_from > today)
        audit["future_ends"] += int(item.valid_to > today)
        if previous:
            if item.valid_from == previous.valid_from:
                key = "duplicates" if item.fingerprint == previous.fingerprint else "conflicts"
                audit[key] += 1
            if item.valid_from <= previous.valid_to:
                audit["overlaps"] += 1
            if item.valid_from > previous.valid_to + timedelta(days=1):
                audit["gaps"] += 1
            if abs(item.value / previous.value - 1) > Decimal("0.10"):
                audit["extreme_changes"] += 1
        previous = item
    if audit["duplicates"] or audit["conflicts"] or audit["overlaps"]:
        raise DataError("Se detectaron duplicados, conflictos o solapamientos", audit)
    return audit
