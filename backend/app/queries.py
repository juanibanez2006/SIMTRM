import calendar
import json
from datetime import date, timedelta
from decimal import Decimal

from app.access import ownership_filter
from app.config import CATALOG_URL, SOURCE_NAME, Settings, now_bogota
from app.db import Database
from app.records import digest
from app.schemas import HistoryFilter, RollingHistoryQuery
from app.sync import automatic_next_check


def rolling_history(db: Database, query: RollingHistoryQuery) -> dict:
    # Project metadata only: matrices and full results stay in their original tables.
    metadata = """
        SELECT rowid AS position, id, result_json,
               json_extract(result_json, '$.created_at') AS created_at,
               json_extract(result_json, '$.request') AS request_json,
               json_extract(result_json, '$.request.settings.method') AS method,
               coalesce(json_extract(result_json, '$.request.unit'), 'transitions') AS unit
        FROM rolling_evaluations
    """
    access, access_params = ownership_filter("rolling_evaluations")
    if access:
        metadata += " WHERE " + access
    # Explicit offsets are normalized to Colombia. Older naive timestamps were local.
    has_offset = """length(created_at) > 19 AND
        (substr(created_at, -1) = 'Z' OR instr(substr(created_at, 20), '+') > 0
         OR instr(substr(created_at, 20), '-') > 0)"""
    local_day = f"""CASE WHEN {has_offset} THEN date(created_at, '-5 hours')
                    ELSE substr(created_at, 1, 10) END"""
    created_order = f"""CASE WHEN {has_offset} THEN julianday(created_at)
                        ELSE julianday(created_at, '+5 hours') END"""
    clauses, params = [], list(access_params)
    for value, expression in (
        (str(query.start) if query.start else None, f"({local_day}) >= ?"),
        (str(query.end) if query.end else None, f"({local_day}) <= ?"),
        (query.method, "method = ?"),
        (query.unit, "unit = ?"),
    ):
        if value is not None:
            clauses.append(expression)
            params.append(value)
    if query.horizon is not None:
        clauses.append("""EXISTS (SELECT 1 FROM json_each(request_json, '$.horizons')
                                 WHERE value = ?)""")
        params.append(query.horizon)
    if query.q.strip():
        # Literal, case-insensitive search: % and _ are not wildcard operators.
        clauses.append(f"""instr(lower(
            coalesce(({local_day}), '') || ' ' ||
            CASE method WHEN 'monte_carlo' THEN 'Montecarlo'
                        WHEN 'arima' THEN 'ARIMA(1,1,0)' ELSE 'Bootstrap' END || ' ' ||
            coalesce(json_extract(request_json, '$.horizons'), '') || ' ' ||
            coalesce(json_extract(request_json, '$.settings.training_records'), '') || ' ' ||
            coalesce(json_extract(request_json, '$.settings.replicas'), '') || ' ' ||
            coalesce(json_extract(request_json, '$.settings.seed'), '') || ' ' ||
            coalesce(json_extract(request_json, '$.settings.volatility_scale'), 1) || ' ' ||
            coalesce(json_extract(request_json, '$.last_cutoff'), '') || ' ' ||
            CASE unit WHEN 'calendar_days' THEN 'días calendario' ELSE 'transiciones' END
            ), lower(?)) > 0""")
        params.append(query.q.strip())
    filtered = "WITH metadata AS (" + metadata + ") SELECT * FROM metadata"
    if clauses:
        filtered += " WHERE " + " AND ".join(clauses)
    with db.connect() as connection:
        connection.execute("BEGIN")  # Count and page share one read snapshot during saves.
        total = connection.execute("SELECT count(*) FROM (" + filtered + ")", params).fetchone()[0]
        rows = connection.execute(
            "SELECT id, created_at, request_json, "
            "coalesce(json_extract(result_json, '$.skipped'), 0) AS skipped, "
            "(SELECT count(DISTINCT json_extract(value, '$.cutoff')) "
            " FROM json_each(result_json, '$.cases')) AS evaluated_folds "
            "FROM (" + filtered + f") ORDER BY ({created_order}) DESC, position DESC "
            "LIMIT ? OFFSET ?",
            [*params, query.page_size, (query.page - 1) * query.page_size],
        ).fetchall()
    return dict(
        items=[
            dict(
                id=row["id"],
                created_at=row["created_at"],
                request=json.loads(row["request_json"]),
                evaluated_folds=row["evaluated_folds"],
                skipped=row["skipped"],
            )
            for row in rows
        ],
        total=total,
        page=query.page,
        page_size=query.page_size,
        pages=(total + query.page_size - 1) // query.page_size,
    )


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
