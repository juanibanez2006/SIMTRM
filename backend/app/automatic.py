import logging
from datetime import timedelta
from threading import Event, Thread

from app.config import Settings, now_bogota
from app.db import Database
from app.locking import SyncBusy, sync_lock
from app.source import SocrataClient
from app.sync import automatic_next_check, recover_interrupted_sync, synchronize

logger = logging.getLogger(__name__)
POLL_SECONDS = 60


class AutomaticSync:
    """One OS-elected scheduler per database; existing sync service owns publication."""

    def __init__(self, db: Database, settings: Settings, source_factory=None):
        self.db, self.settings = db, settings
        self.source_factory = source_factory or (lambda: SocrataClient(settings))
        self.stop_event = Event()
        self.thread = Thread(target=self._run, name="simtrm-auto-sync", daemon=False)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def join(self):
        self.thread.join()

    def check_once(self):
        with self.db.connect() as connection:
            success = connection.execute(
                "SELECT * FROM sync_runs WHERE status='success' ORDER BY id DESC LIMIT 1"
            ).fetchone()
            attempt = connection.execute(
                "SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
        due = automatic_next_check(
            success, attempt, timedelta(hours=self.settings.auto_sync_interval_hours)
        )
        if due is not None and now_bogota() < due:
            return
        if self.stop_event.is_set():
            return
        source = self.source_factory()
        source.stop_event = self.stop_event
        try:
            # Eligibility is checked again under the manual sync lock, closing worker races.
            synchronize(self.db, self.settings, source, "incremental", automatic=True)
        finally:
            source.close()

    def _run(self):
        while not self.stop_event.is_set():
            try:
                with sync_lock(self.db.path, suffix=".automatic.lock"):
                    self._lead()
            except SyncBusy:
                pass  # Another worker is the scheduler. Retry leadership without HTTP requests.
            except Exception:
                logger.exception("No se pudo iniciar la comprobación automática")
            self.stop_event.wait(POLL_SECONDS)

    def _lead(self):
        while not self.stop_event.is_set():
            try:
                recover_interrupted_sync(self.db)
                self.check_once()
            except SyncBusy:
                pass  # A manual sync owns publication; recheck its result next minute.
            except Exception:
                if not self.stop_event.is_set():
                    logger.warning("Falló la comprobación automática; se conserva la copia local")
            # Cheap local eligibility/leadership checks; external checks are at most every 6h.
            self.stop_event.wait(POLL_SECONDS)
