"""
Application configuration — strict, typed, fail-fast.

Design notes (Principal Architect)
==================================
1.  All configuration is sourced from environment variables (12-factor).
    A local ``.env`` file is honoured for developer convenience only.

2.  **Fail-fast on insecure production config.**  If ``APP_ENV=production``
    and any secret still carries a known development default (or is too
    weak), the process refuses to boot with a ``RuntimeError``.  A booking
    marketplace holding escrow funds must never come up half-configured;
    crashing at import time is the cheapest possible failure mode.

3.  Secrets are typed as ``SecretStr`` so they are masked in logs,
    tracebacks and ``repr()`` output.  Call ``.get_secret_value()`` only
    at the point of use (e.g. when building the JWT signer).

4.  ``get_settings()`` is cached: exactly one ``Settings`` instance per
    process, importable from anywhere without re-parsing the environment.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, computed_field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# ---------------------------------------------------------------------------
# Known insecure defaults.
#
# These are the placeholder values shipped in ``.env.example`` / docker-compose
# for local development.  If ANY of them survives into a production
# environment, startup is aborted.  Keep this set in sync with .env.example.
# ---------------------------------------------------------------------------
_INSECURE_DEFAULTS: frozenset[str] = frozenset(
    {
        "",
        "changeme",
        "CHANGE_ME",
        "CHANGE_ME_IN_PRODUCTION",
        "secret",
        "supersecret",
        "dev-secret-key",
        "dev-jwt-secret",
        "postgres",
        "password",
        "admin",
        "redispass",
        "dev-registry-salt",
        "dev-khur-key",
        "dev-emongolia-secret",
        "dev-qpay-webhook-secret",
    }
)

#: Minimum entropy requirement for signing keys in production (characters).
_MIN_PROD_SECRET_LENGTH = 32


class Settings(BaseSettings):
    """Strongly-typed application settings, loaded once at process start."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",  # unrelated env vars (PATH, HOME, ...) are not errors
    )

    # ------------------------------------------------------------------ #
    # Application identity
    # ------------------------------------------------------------------ #
    APP_NAME: str = "hotel-marketplace"
    APP_ENV: Literal["local", "development", "staging", "production"] = "local"
    DEBUG: bool = False
    API_V1_PREFIX: str = "/api/v1"

    #: Browser origins allowed to call the API (CORS). Override via env as a
    #: JSON array, e.g. CORS_ALLOW_ORIGINS='["https://app.example.mn"]'.
    #: Wildcards are refused in production by the fail-fast guard below.
    CORS_ALLOW_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",   # dev fallback port (3000 often occupied)
        "http://127.0.0.1:3001",
    ]

    # ------------------------------------------------------------------ #
    # Security / cryptography
    # ------------------------------------------------------------------ #
    SECRET_KEY: SecretStr = SecretStr("dev-secret-key")
    JWT_SECRET_KEY: SecretStr = SecretStr("dev-jwt-secret")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(default=30, ge=5, le=24 * 60)
    REFRESH_TOKEN_EXPIRE_DAYS: int = Field(default=14, ge=1, le=90)

    #: Salt used when hashing guest identity documents into ``registry_hash``
    #: values for the police-realm matching pipeline.  NEVER reuse SECRET_KEY:
    #: rotating the app key must not invalidate the police registry.
    REGISTRY_HASH_SALT: SecretStr = SecretStr("dev-registry-salt")

    # ------------------------------------------------------------------ #
    # PostgreSQL (asyncpg)
    # ------------------------------------------------------------------ #
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "app_user"
    POSTGRES_PASSWORD: SecretStr = SecretStr("postgres")
    POSTGRES_DB: str = "hotel_marketplace"
    DB_POOL_SIZE: int = Field(default=10, ge=1, le=100)
    DB_MAX_OVERFLOW: int = Field(default=20, ge=0, le=100)
    DB_POOL_RECYCLE_SECONDS: int = Field(default=1_800, ge=60)
    DB_ECHO: bool = False  # SQL logging; must stay False in production

    # ------------------------------------------------------------------ #
    # Redis (cache, rate limiting, escrow-release job queue)
    # ------------------------------------------------------------------ #
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_DB: int = Field(default=0, ge=0, le=15)
    REDIS_PASSWORD: SecretStr | None = None

    # ------------------------------------------------------------------ #
    # Government integrations (State KHUR registry, e-Mongolia OAuth)
    # ------------------------------------------------------------------ #
    #: When True, ``gov_service`` wires deterministic mock adapters instead
    #: of calling the real state APIs. MUST be False in production —
    #: enforced by the fail-fast guard below.
    GOV_USE_MOCKS: bool = True
    KHUR_API_BASE_URL: str = "https://xyp.gov.mn/api/v1"
    KHUR_API_KEY: SecretStr = SecretStr("dev-khur-key")
    EMONGOLIA_AUTH_BASE_URL: str = "https://sso.e-mongolia.mn/oauth2"
    EMONGOLIA_CLIENT_ID: str = "dev-emongolia-client"
    EMONGOLIA_CLIENT_SECRET: SecretStr = SecretStr("dev-emongolia-secret")
    EMONGOLIA_REDIRECT_URI: str = (
        "http://localhost:8000/api/v1/auth/emongolia/callback"
    )
    #: Max age of the signed OAuth ``state`` parameter (CSRF window).
    EMONGOLIA_STATE_TTL_SECONDS: int = Field(default=600, ge=60)

    # ------------------------------------------------------------------ #
    # Police-realm database credentials
    # ------------------------------------------------------------------ #
    #: Separate LOGIN role (see scripts/enable_rls.sql). The police matcher
    #: connects with credentials the app runtime never possesses, so even a
    #: fully compromised app server cannot read the wanted-persons registry.
    POSTGRES_POLICE_USER: str = "police_runtime"
    POSTGRES_POLICE_PASSWORD: SecretStr = SecretStr("postgres")

    # ------------------------------------------------------------------ #
    # Payments / escrow
    # ------------------------------------------------------------------ #
    #: How long a payment Idempotency-Key is remembered (replay window).
    IDEMPOTENCY_TTL_SECONDS: int = Field(default=86_400, ge=60)

    # ------------------------------------------------------------------ #
    # QPay (B2C marketplace payment gateway)
    # ------------------------------------------------------------------ #
    #: When True, qpay_service wires the deterministic mock invoice client.
    QPAY_USE_MOCKS: bool = True
    #: Shared secret QPay signs webhook callbacks with (HMAC-SHA256). The
    #: webhook rejects unsigned/forged calls. MUST be rotated in production.
    QPAY_WEBHOOK_SECRET: SecretStr = SecretStr("dev-qpay-webhook-secret")
    #: Base for the mock QR/deeplink returned in the invoice.
    QPAY_INVOICE_BASE_URL: str = "https://qpay.mn/q"
    #: Invoice validity window surfaced to the guest (minutes).
    QPAY_INVOICE_TTL_MINUTES: int = Field(default=15, ge=1)

    # ------------------------------------------------------------------ #
    # Janitor (background sweeps)
    # ------------------------------------------------------------------ #
    JANITOR_INTERVAL_SECONDS: int = Field(default=300, ge=30)
    #: A PENDING booking / PLACED order that stays unpaid this long is a
    #: checkout the guest abandoned — cancel it and free the room dates.
    PENDING_PAYMENT_TTL_MINUTES: int = Field(default=15, ge=1)

    # ------------------------------------------------------------------ #
    # Business rules (platform-level, environment-tunable)
    # ------------------------------------------------------------------ #
    #: Commission the platform retains on every booking / food order (5%).
    PLATFORM_COMMISSION_RATE: float = Field(default=0.05, ge=0.0, le=0.5)
    #: ISO-4217 currency the platform wallet settles in.
    PLATFORM_CURRENCY: str = Field(default="MNT", min_length=3, max_length=3)

    # ------------------------------------------------------------------ #
    # Derived connection strings
    # ------------------------------------------------------------------ #
    @computed_field  # type: ignore[prop-decorator]
    @property
    def DATABASE_URL(self) -> str:
        """Async SQLAlchemy DSN (asyncpg driver)."""
        pwd = self.POSTGRES_PASSWORD.get_secret_value()
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{pwd}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def SYNC_DATABASE_URL(self) -> str:
        """Sync DSN — used exclusively by Alembic migrations."""
        pwd = self.POSTGRES_PASSWORD.get_secret_value()
        return (
            f"postgresql+psycopg://{self.POSTGRES_USER}:{pwd}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def POLICE_DATABASE_URL(self) -> str:
        """Async DSN for the police-realm engine (separate DB role)."""
        pwd = self.POSTGRES_POLICE_PASSWORD.get_secret_value()
        return (
            f"postgresql+asyncpg://{self.POSTGRES_POLICE_USER}:{pwd}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def REDIS_URL(self) -> str:
        auth = ""
        if self.REDIS_PASSWORD is not None:
            auth = f":{self.REDIS_PASSWORD.get_secret_value()}@"
        return f"redis://{auth}{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    # ------------------------------------------------------------------ #
    # FAIL-FAST GUARD
    # ------------------------------------------------------------------ #
    @model_validator(mode="after")
    def _enforce_production_hardening(self) -> "Settings":
        """
        Abort startup when production is misconfigured.

        Raises:
            RuntimeError: if ``APP_ENV=production`` and any secret is a known
                development default, any signing key is too short, or debug
                facilities are left enabled.
        """
        if self.APP_ENV != "production":
            return self

        violations: list[str] = []

        secrets_to_audit: dict[str, str] = {
            "SECRET_KEY": self.SECRET_KEY.get_secret_value(),
            "JWT_SECRET_KEY": self.JWT_SECRET_KEY.get_secret_value(),
            "REGISTRY_HASH_SALT": self.REGISTRY_HASH_SALT.get_secret_value(),
            "POSTGRES_PASSWORD": self.POSTGRES_PASSWORD.get_secret_value(),
            "POSTGRES_POLICE_PASSWORD": (
                self.POSTGRES_POLICE_PASSWORD.get_secret_value()
            ),
            "KHUR_API_KEY": self.KHUR_API_KEY.get_secret_value(),
            "EMONGOLIA_CLIENT_SECRET": (
                self.EMONGOLIA_CLIENT_SECRET.get_secret_value()
            ),
            "QPAY_WEBHOOK_SECRET": self.QPAY_WEBHOOK_SECRET.get_secret_value(),
        }
        for name, value in secrets_to_audit.items():
            if value in _INSECURE_DEFAULTS:
                violations.append(f"{name} is set to a known development default")

        for name in ("SECRET_KEY", "JWT_SECRET_KEY", "REGISTRY_HASH_SALT"):
            if len(secrets_to_audit[name]) < _MIN_PROD_SECRET_LENGTH:
                violations.append(
                    f"{name} must be at least {_MIN_PROD_SECRET_LENGTH} characters"
                )

        if self.GOV_USE_MOCKS:
            violations.append(
                "GOV_USE_MOCKS must be False in production "
                "(mock KHUR/e-Mongolia adapters fabricate citizen identities)"
            )
        if self.QPAY_USE_MOCKS:
            violations.append(
                "QPAY_USE_MOCKS must be False in production "
                "(mock QPay auto-approves invoices)"
            )
        if any("*" in origin for origin in self.CORS_ALLOW_ORIGINS) or any(
            origin.startswith("http://") for origin in self.CORS_ALLOW_ORIGINS
        ):
            violations.append(
                "CORS_ALLOW_ORIGINS must be explicit https:// origins in "
                "production (no wildcards, no plain http)"
            )
        if self.DEBUG:
            violations.append("DEBUG must be False in production")
        if self.DB_ECHO:
            violations.append("DB_ECHO must be False in production (leaks SQL/PII)")

        if violations:
            bullet_list = "\n".join(f"  - {v}" for v in violations)
            raise RuntimeError(
                "REFUSING TO START: insecure production configuration detected.\n"
                f"{bullet_list}\n"
                "Fix the environment variables above and restart."
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Return the process-wide ``Settings`` singleton.

    Cached so the environment is parsed (and the fail-fast guard runs)
    exactly once, at first import — i.e. before the ASGI server accepts
    a single request.
    """
    return Settings()


#: Eagerly instantiated so a misconfigured production deploy dies at
#: import time, not on the first request.
settings: Settings = get_settings()
