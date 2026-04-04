from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Gmail / IMAP
    EMAIL_USER: str
    EMAIL_PASSWORD: str
    IMAP_SERVER: str = "imap.gmail.com"
    IMAP_PORT: int = 993
    FILTER_SENDER: str
    TARGET_SUBJECT: str

    # NVIDIA NIM
    NVIDIA_API_BASE_URL: str = "https://integrate.api.nvidia.com/v1"
    NVIDIA_API_KEY: str
    NVIDIA_LLM_MODEL: str = "nvidia/nemotron-3-super-120b-a12b"
    NVIDIA_PARSE_MODEL: str = "nvidia/nemotron-parse"

    # PostgreSQL (local pgAdmin database)
    PG_HOST: str = "localhost"
    PG_PORT: int = 5432
    PG_DATABASE: str = "email_parser"
    PG_USER: str = "postgres"
    PG_PASSWORD: str = "postgres"

    # Limit how many attachments are processed per run.
    # Set to 0 (or remove) to process ALL attachments.
    MAX_ATTACHMENTS: int = 5

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
