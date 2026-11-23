from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://totoro.banrep.gov.co/sdmx/rest/data/BANREP.CIE,DF_TRM/"
CATALOG_URL = "https://suameca.banrep.gov.co/estadisticas-economicas/"
SOURCE_NAME = "Banco de la República · TRM certificada por la Superintendencia Financiera"


def now_bogota() -> datetime:
    return datetime.now(ZoneInfo("America/Bogota"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    database_path: Path = ROOT / "data" / "simtrm.sqlite3"
    source_timeout_seconds: float = Field(default=30, gt=0, le=300)
    source_trust_env: bool = False
    source_retries: int = Field(default=3, ge=0, le=6)
    source_backoff_seconds: float = Field(default=1, ge=0, le=30)
    sync_lookback_days: int = Field(default=60, ge=1, le=3650)
    auto_sync_enabled: bool = True
    auto_sync_interval_hours: float = Field(default=6, ge=1 / 60, le=168)
    admin_token: SecretStr | None = None
    public_mode: bool = False
    public_origin: str = ""
    session_secret: SecretStr | None = None
    frontend_dist_path: Path | None = None
    public_requests_per_minute: int = Field(default=120, ge=1, le=10000)
    public_jobs_per_hour: int = Field(default=60, ge=1, le=1000)
    public_global_jobs_per_hour: int = Field(default=120, ge=1, le=10000)
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    def resolved_database_path(self) -> Path:
        path = self.database_path
        return path if path.is_absolute() else ROOT / path

    @model_validator(mode="after")
    def public_settings(self):
        if self.public_mode:
            origin = urlsplit(self.public_origin)
            if origin.scheme != "https" or not origin.netloc or origin.path not in {"", "/"}:
                raise ValueError("PUBLIC_ORIGIN debe ser el origen HTTPS del aplicativo")
            self.public_origin = self.public_origin.rstrip("/")
            if any(secret is None or len(secret.get_secret_value()) < 32
                   for secret in (self.session_secret, self.admin_token)):
                raise ValueError("Producción requiere SESSION_SECRET y ADMIN_TOKEN seguros")
            if self.frontend_dist_path is None:
                raise ValueError("Producción requiere FRONTEND_DIST_PATH")
        return self
