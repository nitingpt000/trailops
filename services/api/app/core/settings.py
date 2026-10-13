from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Names match the template in `.env.example` (spec §26)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://trailops:trailops@localhost:55432/trailops"
    oidc_issuer: str = "http://localhost:8080/realms/trailops"
    # Extra issuers accepted for the same realm, e.g. the emulator-reachable URL. Comma separated.
    oidc_additional_issuers: str = ""
    oidc_audience: str = "trailops-api"
    oidc_jwks_url: str = ""  # defaults to the issuer's certs endpoint
    jwks_cache_ttl: int = 300
    storage_backend: str = "local"  # local | s3
    storage_endpoint: str = "http://localhost:9000"
    storage_bucket: str = "trailops-evidence"
    storage_access_key: str = ""
    storage_secret_key: str = ""
    local_storage_dir: str = ".storage"
    public_api_base: str = "http://localhost:8000"
    web_origins: str = "http://localhost:5173"
    sync_protocol_version: int = 1
    offline_allowance_hours: int = 72
    change_retention_days: int = 90
    operation_retention_days: int = 180
    max_command_batch: int = 50
    max_request_bytes: int = 1024 * 1024
    max_photo_bytes: int = 5 * 1024 * 1024
    max_photos_per_return: int = 3
    due_date_grace_days: int = 2
    upload_url_ttl_seconds: int = 900
    # HMAC key for sync cursors and local upload slots. Demo default only; override in any shared deployment.
    signing_secret: str = "dev-only-signing-secret-change-me"

    @property
    def accepted_issuers(self) -> list[str]:
        extra = [i.strip() for i in self.oidc_additional_issuers.split(",") if i.strip()]
        return [self.oidc_issuer, *extra]

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.web_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
