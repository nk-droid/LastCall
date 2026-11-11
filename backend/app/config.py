"""Runtime configuration.

All secrets come from the environment (or backend/.env locally) and never leave the server.
Production refuses to start without the settings it can't safely default.
"""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_env: Literal["development", "test", "production"] = "development"

    # Database: an explicit PostgreSQL URL. Development without one falls back to an
    # embedded PostgreSQL server (pgserver) kept under data_dir/pg.
    database_url: str | None = None
    database_pool_size: int = 5
    database_max_overflow: int = 10
    data_dir: Path = BACKEND_DIR / ".data"

    # Browser-facing origin of the web app; used for CSRF origin checks and links in emails.
    public_app_url: str = "http://localhost:3787"
    extra_allowed_origins: list[str] = Field(default_factory=list)
    secret_key: str | None = None
    trust_proxy: bool = True

    # PayPal (the only payment provider). The API host is fixed to the Sandbox in this build, so
    # test credentials can never move real money. Checkout is unavailable until the app's client
    # ID and secret are set; the webhook ID enables signature verification of PayPal events.
    paypal_client_id: str | None = None
    paypal_client_secret: str | None = None
    paypal_webhook_id: str | None = None
    paypal_timeout_seconds: float = 20.0
    paypal_brand_name: str = "LastCall"
    # "Connect with PayPal" for shop payouts (Log in with PayPal). Turn on Log in with PayPal in the PayPal app, with the
    # email and "PayPal account ID (payer ID)" / account verification attributes, and add {PUBLIC_APP_URL}/merchant/paypal/return
    # as its return URL. When off, owners enter their merchant ID instead.
    paypal_connect_enabled: bool = False

    # LLM adapter. "ollama" calls Ollama through LangChain (ChatOllama): by default Ollama's cloud
    # API, authenticated with OLLAMA_API_KEY. A local daemon works too (OLLAMA_HOST=http://localhost:11434,
    # LLM_MODEL=gpt-oss:120b-cloud, no key). "none" disables AI and uses deterministic rules.
    llm_provider: Literal["ollama", "none"] = "ollama"
    ollama_host: str = "https://ollama.com"
    ollama_api_key: str | None = None
    llm_model: str = "gpt-oss:120b"
    llm_think: Literal["low", "medium", "high"] = "low"
    llm_timeout_seconds: float = 20.0
    ai_bundle_rationale: bool = True
    # Agents (tool-calling loops) use their own model on the same Ollama host and key. On the cloud API
    # the name has no suffix ("beam"); through a local daemon it is "beam:cloud".
    agent_model: str = "beam"
    agent_max_steps: int = 8
    agent_timeout_seconds: float = 45.0

    # Background worker (runs inside the API process unless disabled).
    worker_enabled: bool = True
    worker_interval_seconds: float = 2.0
    # Apply migrations on startup, serialized with an advisory lock.
    auto_migrate: bool = True

    # Outbound email over SMTP (any provider; a Gmail app password works). Without SMTP_HOST,
    # queued emails are marked "skipped" and the console shows invite and reset links to share.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "LastCall <no-reply@lastcall.app>"
    smtp_starttls: bool = True

    # Lets platform admins arm PayPal failure injection (lost capture responses, timeouts,
    # declines) to demonstrate and test recovery. Sandbox only; keep off unless you need it.
    ops_faults_enabled: bool = False

    # Bearer token for /api/metrics. Without one the endpoint is only served outside production.
    metrics_token: str | None = None

    log_level: str = "INFO"
    log_json: bool = True

    @property
    def mail_configured(self) -> bool:
        return bool(self.smtp_host)

    @property
    def paypal_configured(self) -> bool:
        return bool(self.paypal_client_id and self.paypal_client_secret)

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def allowed_origins(self) -> set[str]:
        origins = {self.public_app_url.rstrip("/")}
        origins.update(o.rstrip("/") for o in self.extra_allowed_origins)
        if not self.is_production:
            # localhost and 127.0.0.1 are the same origin for local development purposes
            for origin in list(origins):
                if "://localhost" in origin:
                    origins.add(origin.replace("://localhost", "://127.0.0.1"))
                elif "://127.0.0.1" in origin:
                    origins.add(origin.replace("://127.0.0.1", "://localhost"))
        return origins

    def resolved_secret_key(self) -> str:
        """Server secret for session, token and pickup-code HMACs.

        Production must set SECRET_KEY. In development a random key is generated
        once and persisted under data_dir so sessions survive restarts.
        """
        if self.secret_key:
            return self.secret_key
        if self.is_production:
            raise RuntimeError("SECRET_KEY must be set in production")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        path = self.data_dir / "secret_key"
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48))
            path.chmod(0o600)
        return path.read_text().strip()

    def validate_for_startup(self) -> None:
        if not self.is_production:
            return
        missing = [name for name, value in (("DATABASE_URL", self.database_url), ("SECRET_KEY", self.secret_key)) if not value]
        if missing:
            raise RuntimeError(f"Missing required production settings: {', '.join(missing)}")
        if not self.public_app_url.startswith("https://"):
            raise RuntimeError("PUBLIC_APP_URL must be an https:// URL in production")


@lru_cache
def get_settings() -> Settings:
    return Settings()


_override: dict[str, Settings] = {}


def settings() -> Settings:
    return _override.get("settings") or get_settings()


def override_settings(**values) -> Settings:
    """Test helper: use explicit settings, ignoring backend/.env."""
    _override["settings"] = Settings(_env_file=None, **values)
    return _override["settings"]


def reset_settings_override() -> None:
    _override.pop("settings", None)
