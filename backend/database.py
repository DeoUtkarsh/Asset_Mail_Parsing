"""
Centralized database client.
Returns a PostgresDatabase instance backed by a local PostgreSQL server.
The `supabase` alias is kept so all agents import without changes.
"""
import logging

from config import settings

logger = logging.getLogger(__name__)


def _create_db():
    from pg_db import PostgresDatabase

    dsn = (
        f"host={settings.PG_HOST} "
        f"port={settings.PG_PORT} "
        f"dbname={settings.PG_DATABASE} "
        f"user={settings.PG_USER} "
        f"password={settings.PG_PASSWORD}"
    )
    logger.info(
        "DB backend: PostgreSQL at %s:%s / %s",
        settings.PG_HOST, settings.PG_PORT, settings.PG_DATABASE,
    )
    return PostgresDatabase(dsn)


# Initialised once at import time — raises immediately if DB is unreachable.
supabase = _create_db()


def get_supabase():
    """Convenience accessor used by main.py health-check."""
    return supabase
