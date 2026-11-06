import argparse
import json

from app.config import Settings
from app.db import Database
from app.queries import data_status, run_out
from app.source import SocrataClient
from app.sync import synchronize


def main():
    parser = argparse.ArgumentParser(description="Mantenimiento local de SIMTRM")
    parser.add_argument("command", choices=["sync", "status"])
    parser.add_argument("--mode", choices=["full", "incremental"], default="full")
    args = parser.parse_args()
    settings = Settings()
    db = Database(settings.resolved_database_path())
    db.initialize()
    if args.command == "status":
        result = data_status(db, settings)
    else:
        source = SocrataClient(settings)
        try:
            result = run_out(synchronize(db, settings, source, args.mode))
        finally:
            source.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
