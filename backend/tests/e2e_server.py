"""Run browser tests against an isolated copy of the real local historical data."""

import sqlite3
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


def main():
    source = Settings().resolved_database_path()
    if not source.is_file():
        raise SystemExit("Sincronice el histórico oficial antes de ejecutar test:e2e.")
    with TemporaryDirectory(prefix="simtrm-e2e-") as directory:
        target = Path(directory) / "e2e.sqlite3"
        # SQLite backup includes committed WAL contents without changing the original.
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
            if original.execute("SELECT COUNT(*) FROM records").fetchone()[0] < 3:
                raise SystemExit(
                    "Se requieren datos oficiales locales para las pruebas integrales."
                )
            with sqlite3.connect(target) as isolated:
                original.backup(isolated)
        app = create_app(Settings(_env_file=None, database_path=target, auto_sync_enabled=False))
        uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")


if __name__ == "__main__":
    main()
