from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://www.datos.gov.co/resource/32sa-8pi3.json"
CATALOG_URL = (
    "https://www.datos.gov.co/Econom-a-y-Finanzas/"
    "Tasa-de-Cambio-Representativa-del-Mercado-TRM/32sa-8pi3"
)
SOURCE_NAME = "Superintendencia Financiera de Colombia · Datos Abiertos Colombia"


def now_bogota() -> datetime:
    return datetime.now(ZoneInfo("America/Bogota"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    database_path: Path = ROOT / "data" / "simtrm.sqlite3"
    source_timeout_seconds: float = Field(default=30, gt=0, le=300)
    source_page_size: int = Field(default=1000, ge=1, le=5000)
    source_retries: int = Field(default=3, ge=0, le=6)
    source_backoff_seconds: float = Field(default=1, ge=0, le=30)
    sync_lookback_days: int = Field(default=60, ge=1, le=3650)
    auto_sync_enabled: bool = True
    auto_sync_interval_hours: float = Field(default=6, ge=1 / 60, le=168)
    socrata_app_token: SecretStr | None = None
    admin_token: SecretStr | None = None
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    def resolved_database_path(self) -> Path:
        path = self.database_path
        return path if path.is_absolute() else ROOT / path
