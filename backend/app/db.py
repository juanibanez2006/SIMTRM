import sqlite3
from contextlib import contextmanager
from pathlib import Path


class Database:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY,
                    value TEXT NOT NULL,
                    unit TEXT NOT NULL CHECK(unit = 'COP'),
                    valid_from TEXT NOT NULL UNIQUE,
                    valid_to TEXT NOT NULL,
                    source_id TEXT,
                    fingerprint TEXT NOT NULL UNIQUE,
                    source TEXT NOT NULL,
                    obtained_at TEXT NOT NULL,
                    validation_state TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS records_valid_to ON records(valid_to);
                CREATE TABLE IF NOT EXISTS revisions (
                    fingerprint TEXT PRIMARY KEY,
                    valid_from TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    obtained_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sync_runs (
                    id INTEGER PRIMARY KEY,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    expected INTEGER,
                    received INTEGER,
                    inserted INTEGER DEFAULT 0,
                    revised INTEGER DEFAULT 0,
                    removed INTEGER DEFAULT 0,
                    error TEXT,
                    audit_json TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_running_sync
                    ON sync_runs(status) WHERE status = 'running';
                CREATE TABLE IF NOT EXISTS simulation_experiments (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    paths_npz BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS backtests (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    evaluation_snapshot_json TEXT NOT NULL
                );
            """)
