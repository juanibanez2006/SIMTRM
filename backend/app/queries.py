import calendar
import json
from datetime import date, timedelta
from decimal import Decimal

from app.config import CATALOG_URL, SOURCE_NAME, Settings, now_bogota
from app.db import Database
from app.records import digest
from app.schemas import HistoryFilter
from app.sync import automatic_next_check


def record_out(row) -> dict | None:
    if row is None:
        return None
    result = dict(row)
    result.pop("raw_json", None)
    result["extended"] = result["valid_to"] > result["valid_from"]
    return result


def where_filter(filters: HistoryFilter) -> tuple[str, list]:
    starts, ends = [], []
    if filters.year:
        month = filters.month
        starts.append(date(filters.year, month or 1, 1).isoformat())
        ends.append(
            date(
                filters.year, month or 12, calendar.monthrange(filters.year, month or 12)[1]
            ).isoformat()
        )
    if filters.start:
        starts.append(filters.start.isoformat())
    if filters.end:
        ends.append(filters.end.isoformat())
    clauses, params = [], []
    # A validity interval intersects the requested range, including a year/month boundary.
    if starts:
        clauses.append("valid_to >= ?")
        params.append(max(starts))
    if ends:
        clauses.append("valid_from <= ?")
        params.append(min(ends))
    if starts and ends and max(starts) > min(ends):
        clauses.append("0")
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), params


def series(db: Database, filters: HistoryFilter) -> dict:
    where, params = where_filter(filters)
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM records" + where + " ORDER BY valid_from ASC",
            params,
        ).fetchall()
    values = [Decimal(row["value"]) for row in rows]
    return {
        "points": [
            {
                "date": row["valid_from"],
                "valid_to": row["valid_to"],
                "value": row["value"],
                "extended": row["valid_from"] < row["valid_to"],
            }
            for row in rows
        ],
        "count": len(rows),
        "mean": str(sum(values) / len(values)) if values else None,
        "minimum": str(min(values)) if values else None,
        "maximum": str(max(values)) if values else None,
        "convention": "Un valor por registro de vigencia que intersecta el periodo; "
        "media aritmética sin ponderación por días calendario.",
    }


def latest(db: Database) -> dict:
    today = now_bogota().date().isoformat()
    with db.connect() as connection:
        connection.execute("BEGIN")
        row = connection.execute(
            "SELECT * FROM records WHERE valid_from <= ? ORDER BY valid_from DESC LIMIT 1",
            (today,),
        ).fetchone()
        if row is None:
            row = connection.execute(
                "SELECT * FROM records ORDER BY valid_from DESC LIMIT 1"
            ).fetchone()
        previous = (
            connection.execute(
                "SELECT * FROM records WHERE valid_from < ? ORDER BY valid_from DESC LIMIT 1",
                (row["valid_from"],),
            ).fetchone()
            if row
            else None
        )
    state = "empty"
    if row:
        state = (
            "future"
            if row["valid_from"] > today
            else "current"
            if row["valid_to"] >= today
            else "stale"
        )
    current_value = Decimal(row["value"]) if row else None
    previous_value = Decimal(previous["value"]) if previous else None
    return {
        "record": record_out(row),
        "previous": record_out(previous),
        "state": state,
        "today": today,
        "delta": str(current_value - previous_value) if previous else None,
        "variation_pct": str((current_value / previous_value - 1) * 100) if previous else None,
    }


def run_out(row) -> dict | None:
    if row is None:
        return None
    result = dict(row)
    result["audit"] = json.loads(result.pop("audit_json") or "{}")
    return result


def data_status(db: Database, settings: Settings | None = None) -> dict:
    settings = settings or Settings()
    checked = now_bogota()
    with db.connect() as connection:
        connection.execute("BEGIN")
        rows = connection.execute("SELECT * FROM records ORDER BY valid_from").fetchall()
        attempt = connection.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
        success = connection.execute(
            "SELECT * FROM sync_runs WHERE status='success' ORDER BY id DESC LIMIT 1",
        ).fetchone()
        versions = connection.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
    state = "local" if rows else "empty"
    if attempt and attempt["status"] == "running":
        state = "syncing"
    elif attempt and attempt["status"] == "failed":
        state = "source_error"
    due = automatic_next_check(success, attempt, timedelta(hours=settings.auto_sync_interval_hours))
    return {
        "total": len(rows),
        "first": record_out(rows[0]) if rows else None,
        "last": record_out(rows[-1]) if rows else None,
        "source": SOURCE_NAME,
        "source_url": CATALOG_URL,
        "timezone": "America/Bogota",
        "last_attempt": run_out(attempt),
        "last_success": run_out(success),
        "state": state,
        "dataset_fingerprint": digest([row["fingerprint"] for row in rows]),
        "stored_versions": versions,
        "today": checked.date().isoformat(),
        "auto_sync_enabled": settings.auto_sync_enabled,
        "auto_sync_interval_hours": settings.auto_sync_interval_hours,
        "next_auto_check_at": max(due or checked, checked).isoformat()
        if settings.auto_sync_enabled
        else None,
    }
