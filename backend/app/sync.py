import json
import sqlite3
from datetime import datetime, timedelta

from app.config import Settings, now_bogota
from app.db import Database
from app.locking import SyncBusy, sync_lock
from app.records import DataError, audit_records, canonical_json, normalize
from app.source import SocrataClient, SourceError, SyncCancelled

INSERT_RECORD = """
    INSERT INTO records(value,unit,valid_from,valid_to,source_id,fingerprint,source,
                        obtained_at,validation_state,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(valid_from) DO UPDATE SET
        value=excluded.value, unit=excluded.unit, valid_to=excluded.valid_to,
        source_id=excluded.source_id, fingerprint=excluded.fingerprint,
        obtained_at=excluded.obtained_at, validation_state=excluded.validation_state,
        raw_json=excluded.raw_json
"""


def automatic_next_check(success, attempt, interval: timedelta) -> datetime | None:
    """Persisted cooldown also prevents retries on every worker start after a failure."""
    anchors = []
    for row in (success, attempt):
        if row is None or not row["finished_at"]:
            continue
        audit = json.loads(row["audit_json"] or "{}")
        if audit.get("interrupted") or audit.get("cancelled"):
            continue
        anchors.append(datetime.fromisoformat(row["finished_at"]))
    return max(anchors) + interval if anchors else None


def recover_interrupted(connection):
    for row in connection.execute("SELECT * FROM sync_runs WHERE status='running'").fetchall():
        audit = json.loads(row["audit_json"] or "{}")
        audit["interrupted"] = 1
        connection.execute(
            "UPDATE sync_runs SET status='failed',finished_at=?,error=?,audit_json=? WHERE id=?",
            (
                now_bogota().isoformat(),
                "Proceso interrumpido; se conserva la copia anterior",
                canonical_json(audit),
                row["id"],
            ),
        )


def recover_interrupted_sync(db: Database):
    # The same publication lock proves that no live manual/automatic sync owns these rows.
    with sync_lock(db.path), db.connect() as connection:
        recover_interrupted(connection)


def synchronize(
    db: Database,
    settings: Settings,
    source: SocrataClient,
    mode: str,
    *,
    automatic: bool = False,
) -> dict | None:
    with sync_lock(db.path):
        with db.connect() as connection:
            recover_interrupted(connection)
            if automatic:
                success = connection.execute(
                    "SELECT * FROM sync_runs WHERE status='success' ORDER BY id DESC LIMIT 1"
                ).fetchone()
                attempt = connection.execute(
                    "SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"
                ).fetchone()
                due = automatic_next_check(
                    success, attempt, timedelta(hours=settings.auto_sync_interval_hours)
                )
                if due is not None and now_bogota() < due:
                    return None
        source.check_cancelled()
        return _synchronize(db, settings, source, mode, automatic=automatic)


def _synchronize(
    db: Database, settings: Settings, source: SocrataClient, mode: str, *, automatic: bool = False
) -> dict:
    started = now_bogota().isoformat()
    try:
        with db.connect() as connection:
            run_id = connection.execute(
                "INSERT INTO sync_runs(mode,status,started_at,audit_json) VALUES(?,'running',?,?)",
                (
                    mode,
                    started,
                    canonical_json({"trigger": "automatic" if automatic else "manual"}),
                ),
            ).lastrowid
    except sqlite3.IntegrityError as exc:
        raise SyncBusy("Ya hay una sincronización en curso") from exc
    expected = received = None
    try:
        with db.connect() as connection:
            latest = connection.execute("SELECT MAX(valid_from) FROM records").fetchone()[0]
        since = None
        if mode == "incremental" and latest:
            from datetime import date

            since = (
                date.fromisoformat(latest) - timedelta(days=settings.sync_lookback_days)
            ).isoformat()
        where = f"vigenciahasta >= '{since}T00:00:00'" if since else None
        global_before = source.summary()
        raw, remote = source.download(where)
        expected, received = remote["total"], len(raw)
        if not raw:
            raise SourceError("La fuente devolvió un conjunto vacío; se conserva la copia local")
        records = []
        rejected = []
        for row in raw:
            try:
                records.append(normalize(row))
            except DataError as exc:
                rejected.append({"raw": row, "error": str(exc)})
        if rejected:
            raise DataError(
                "La descarga contiene registros inválidos",
                {"rejected": len(rejected), "rejected_rows": rejected},
            )
        if source.summary() != global_before:
            raise SourceError("La fuente cambió durante la sincronización")
        fetched_at = now_bogota().isoformat()
        source.check_cancelled()
        with db.connect() as connection:
            existing = {
                row["valid_from"]: row for row in connection.execute("SELECT * FROM records")
            }
            retained = [
                normalize(json.loads(row["raw_json"]))
                for row in existing.values()
                if since and row["valid_to"] < since
            ]
            combined = sorted(retained + records, key=lambda row: row.valid_from)
            audit = audit_records(combined, now_bogota().date())
            audit["trigger"] = "automatic" if automatic else "manual"
            if len(combined) != global_before["total"]:
                raise SourceError(
                    "El total local no coincide con la fuente; ejecute una sincronización completa"
                )
            if (
                combined[0].valid_from.isoformat() != global_before["first"][:10]
                or combined[-1].valid_to.isoformat() != global_before["last"][:10]
            ):
                raise SourceError("La cobertura local no coincide con la fuente")
            incoming_dates = {str(row.valid_from) for row in combined}
            removed = len(set(existing) - incoming_dates)
            inserted = sum(str(row.valid_from) not in existing for row in records)
            revised = sum(
                str(row.valid_from) in existing
                and existing[str(row.valid_from)]["fingerprint"] != row.fingerprint
                for row in records
            )
            # Keep every original version before updating the current validated dataset.
            source.check_cancelled()
            for row in records:
                connection.execute(
                    "INSERT OR IGNORE INTO revisions VALUES(?,?,?,?)",
                    (row.fingerprint, str(row.valid_from), row.raw_json, fetched_at),
                )
            if since:
                connection.execute("DELETE FROM records WHERE valid_to >= ?", (since,))
            else:
                connection.execute("DELETE FROM records")
            connection.executemany(INSERT_RECORD, [row.storage(fetched_at) for row in records])
            audit["remote_total"] = global_before["total"]
            audit["window_start"] = since
            connection.execute(
                """UPDATE sync_runs SET status='success',finished_at=?,expected=?,received=?,
                   inserted=?,revised=?,removed=?,audit_json=? WHERE id=?""",
                (
                    fetched_at,
                    expected,
                    received,
                    inserted,
                    revised,
                    removed,
                    canonical_json(audit),
                    run_id,
                ),
            )
            return dict(
                connection.execute("SELECT * FROM sync_runs WHERE id=?", (run_id,)).fetchone()
            )
    except Exception as exc:
        message = (
            str(exc)
            if isinstance(exc, (SourceError, DataError))
            else "Error interno de sincronización"
        )
        audit = exc.audit if isinstance(exc, DataError) else {}
        audit = {**audit, "trigger": "automatic" if automatic else "manual"}
        if isinstance(exc, SyncCancelled):
            audit["cancelled"] = 1
        with db.connect() as connection:
            connection.execute(
                """UPDATE sync_runs SET status='failed',finished_at=?,expected=?,received=?,
                   error=?,audit_json=? WHERE id=?""",
                (
                    now_bogota().isoformat(),
                    expected,
                    received,
                    message,
                    canonical_json(audit),
                    run_id,
                ),
            )
        if isinstance(exc, (SourceError, DataError)):
            raise
        raise SourceError(message) from exc
