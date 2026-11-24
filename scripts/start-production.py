"""Single-process production entry point; durable state must live on the mounted volume."""

import os
import shutil
import sys
from pathlib import Path

import uvicorn


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    os.umask(0o077)
    if os.environ.get("WEB_CONCURRENCY", "1") != "1":
        raise RuntimeError("SQLite y los límites de ejecución requieren un solo proceso")
    if os.environ.get("RAILWAY_PROJECT_ID"):
        mount = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
        if not mount:
            raise RuntimeError("No se encontró el volumen persistente de Railway")
        volume = Path(mount).resolve(strict=True)
        database = Path(os.environ["DATABASE_PATH"]).resolve()
        if not database.is_relative_to(volume):
            raise RuntimeError("DATABASE_PATH debe estar dentro del volumen persistente")
        if hasattr(os, "getuid") and os.getuid() == 0:
            os.chown(volume, 10001, 10001)
            os.chmod(volume, 0o700)
            os.setgroups([])
            os.setgid(10001)
            os.setuid(10001)
        storage = shutil.disk_usage(volume)
        print(
            f"Persistent storage: total={storage.total} free={storage.free} "
            f"database={database.stat().st_size if database.exists() else 0}",
            flush=True,
        )
    uvicorn.run(
        "app.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8080")),
        workers=1, proxy_headers=True, forwarded_allow_ips="*", limit_concurrency=40,
        timeout_keep_alive=5, timeout_graceful_shutdown=90,
    )


if __name__ == "__main__":
    main()
