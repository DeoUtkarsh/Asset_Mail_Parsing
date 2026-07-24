from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent / ".env"


class Settings(BaseSettings):
    # Gmail / IMAP
    EMAIL_USER: str
    EMAIL_PASSWORD: str
    IMAP_SERVER: str = "imap.gmail.com"
    IMAP_PORT: int = 993

    # Automated/notification senders to skip when fetching (comma-separated
    # substrings, matched case-insensitively against the whole From header).
    BLOCKED_SENDER_PATTERNS: str = (
        "google.com,accounts.google.com,no-reply,noreply,donotreply,"
        "mailer-daemon,postmaster"
    )

    # Anthropic Claude (primary LLM — text + vision + PDF)
    ANTHROPIC_API_KEY: str
    CLAUDE_MODEL: str = "claude-haiku-4-5"

    # ── NVIDIA NIM (legacy — kept for reference, no longer used) ──────────
    # These are optional now; leave unset in .env. Retained so the old
    # NVIDIA code paths still import cleanly if ever re-enabled.
    NVIDIA_API_BASE_URL: str = "https://integrate.api.nvidia.com/v1"
    NVIDIA_API_KEY: str = ""
    NVIDIA_LLM_MODEL: str = "nvidia/nemotron-3-super-120b-a12b"
    NVIDIA_PARSE_MODEL: str = "nvidia/nemotron-parse"

    # PostgreSQL (local pgAdmin database)
    PG_HOST: str = "localhost"
    PG_PORT: int = 5432
    PG_DATABASE: str = "email_parser_dev"
    PG_USER: str = "postgres"
    PG_PASSWORD: str = "postgres"

    # Max broker emails to process per fetch. 0 = all. Only NEW emails
    # (unseen Message-IDs) are ever processed regardless of this cap.
    MAX_ATTACHMENTS: int = 0

    # LLM extraction tuning (used by contact/vessel extraction retry logic)
    EXTRACTION_MAX_ATTEMPTS: int = 3
    EXTRACTION_RATE_LIMIT_BASE_SEC: float = 5.0
    EXTRACTION_REQUEST_DELAY_SEC: float = 1.0

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def blocked_sender_patterns(self) -> list[str]:
        return [
            p.strip().lower()
            for p in (self.BLOCKED_SENDER_PATTERNS or "").split(",")
            if p.strip()
        ]


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
