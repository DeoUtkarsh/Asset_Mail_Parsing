"""
PostgreSQL database backend.
Implements a Supabase-compatible query-builder interface backed by psycopg2
so that all agents can remain unchanged.
"""
import json
import uuid
import logging
from typing import Any, Optional

import psycopg2
import psycopg2.extras
import psycopg2.pool

logger = logging.getLogger(__name__)

# ── Schema DDL (runs at startup; CREATE IF NOT EXISTS is idempotent) ──────────
_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS parent_emails (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject         TEXT NOT NULL,
    sender          TEXT NOT NULL DEFAULT '',
    date_received   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL DEFAULT 'fetching',
    message_id      TEXT UNIQUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_email_id   UUID NOT NULL REFERENCES parent_emails(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL DEFAULT '',
    raw_text          TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    error_message     TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_parent_email_id
    ON attachments(parent_email_id);

CREATE TABLE IF NOT EXISTS vessels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    dynamic_data    JSONB NOT NULL DEFAULT '{}',
    region          TEXT,
    is_validated    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vessels_attachment_id
    ON vessels(attachment_id);

CREATE INDEX IF NOT EXISTS idx_vessels_region
    ON vessels(region);

CREATE INDEX IF NOT EXISTS idx_vessels_dynamic_data
    ON vessels USING GIN (dynamic_data);

CREATE OR REPLACE VIEW vessels_full AS
SELECT
    v.id,
    v.attachment_id,
    v.dynamic_data,
    v.region,
    v.is_validated,
    v.created_at,
    a.filename,
    a.parent_email_id,
    pe.subject,
    pe.date_received
FROM vessels v
JOIN attachments a  ON a.id  = v.attachment_id
JOIN parent_emails pe ON pe.id = a.parent_email_id;
"""


# ── Query result wrapper (same shape as supabase-py) ─────────────────────────

class QueryResult:
    def __init__(self, data: list[dict]):
        self.data = data


# ── Query builder ─────────────────────────────────────────────────────────────

class QueryBuilder:
    def __init__(self, pool: psycopg2.pool.SimpleConnectionPool, table: str):
        self._pool = pool
        self._table = table
        self._operation = "select"
        self._columns = "*"
        self._filters: list[tuple] = []   # (op, column, value)
        self._data: Optional[dict] = None
        self._limit_val: Optional[int] = None
        self._order_col: Optional[str] = None
        self._order_desc = False
        self._is_single = False

    # ── Fluent API ────────────────────────────────────────────────────────────

    def select(self, columns: str = "*") -> "QueryBuilder":
        self._operation = "select"
        self._columns = columns
        return self

    def insert(self, data: dict) -> "QueryBuilder":
        self._operation = "insert"
        self._data = data
        return self

    def update(self, data: dict) -> "QueryBuilder":
        self._operation = "update"
        self._data = data
        return self

    def delete(self) -> "QueryBuilder":
        self._operation = "delete"
        return self

    def eq(self, column: str, value: Any) -> "QueryBuilder":
        self._filters.append(("eq", column, value))
        return self

    def in_(self, column: str, values: list) -> "QueryBuilder":
        self._filters.append(("in", column, values))
        return self

    def limit(self, n: int) -> "QueryBuilder":
        self._limit_val = n
        return self

    def order(self, column: str, desc: bool = False) -> "QueryBuilder":
        self._order_col = column
        self._order_desc = desc
        return self

    def single(self) -> "QueryBuilder":
        """Return at most one row (mirrors Supabase .single())."""
        self._is_single = True
        self._limit_val = 1
        return self

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _build_where(self, params: list) -> str:
        if not self._filters:
            return ""
        clauses = []
        for op, col, val in self._filters:
            if op == "eq":
                clauses.append(f"{col} = %s")
                params.append(val)
            elif op == "in":
                placeholders = ", ".join(["%s"] * len(val))
                clauses.append(f"{col} IN ({placeholders})")
                params.extend(val)
        return " WHERE " + " AND ".join(clauses)

    # ── Execute ───────────────────────────────────────────────────────────────

    def execute(self) -> QueryResult:
        conn = self._pool.getconn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if self._operation == "select":
                    params: list = []
                    sql = f"SELECT {self._columns} FROM {self._table}"
                    sql += self._build_where(params)
                    if self._order_col:
                        direction = "DESC" if self._order_desc else "ASC"
                        sql += f" ORDER BY {self._order_col} {direction}"
                    if self._limit_val:
                        sql += f" LIMIT {self._limit_val}"
                    cur.execute(sql, params)
                    rows = [_row_to_dict(r) for r in cur.fetchall()]
                    return QueryResult([rows[0]] if self._is_single and rows else rows)

                elif self._operation == "insert":
                    data = _prepare_data(self._data)
                    if not data.get("id"):
                        data["id"] = str(uuid.uuid4())
                    cols = list(data.keys())
                    placeholders = ", ".join(["%s"] * len(cols))
                    vals = [data[c] for c in cols]
                    sql = (
                        f"INSERT INTO {self._table} ({', '.join(cols)}) "
                        f"VALUES ({placeholders}) RETURNING *"
                    )
                    cur.execute(sql, vals)
                    row = _row_to_dict(cur.fetchone())
                    conn.commit()
                    return QueryResult([row])

                elif self._operation == "update":
                    data = _prepare_data(self._data)
                    set_clauses = ", ".join([f"{k} = %s" for k in data.keys()])
                    params = list(data.values())
                    sql = f"UPDATE {self._table} SET {set_clauses}"
                    sql += self._build_where(params)
                    sql += " RETURNING *"
                    cur.execute(sql, params)
                    rows = [_row_to_dict(r) for r in cur.fetchall()]
                    conn.commit()
                    return QueryResult(rows)

                elif self._operation == "delete":
                    params = []
                    sql = f"DELETE FROM {self._table}"
                    sql += self._build_where(params)
                    cur.execute(sql, params)
                    conn.commit()
                    return QueryResult([])

                return QueryResult([])
        finally:
            self._pool.putconn(conn)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    """Convert RealDictRow to plain dict; JSONB comes back as dict already."""
    if row is None:
        return {}
    return dict(row)


def _prepare_data(data: Optional[dict]) -> dict:
    """
    Serialize Python dicts/lists to psycopg2.extras.Json so psycopg2 can
    correctly insert them into JSONB columns.
    """
    prepared = {}
    for k, v in (data or {}).items():
        if isinstance(v, (dict, list)):
            prepared[k] = psycopg2.extras.Json(v)
        else:
            prepared[k] = v
    return prepared


# ── Main database class ───────────────────────────────────────────────────────

class PostgresDatabase:
    """
    Thin wrapper around a psycopg2 connection pool.
    Exposes `.table(name)` which returns a fluent QueryBuilder.
    """

    def __init__(self, dsn: str):
        logger.info("Connecting to PostgreSQL…")
        self._pool = psycopg2.pool.SimpleConnectionPool(1, 10, dsn)
        logger.info("Connection pool ready")
        self._init_schema()

    def _init_schema(self) -> None:
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(_SCHEMA_SQL)
            conn.commit()
            logger.info("PostgreSQL schema verified (tables + view exist)")
        except Exception as exc:
            conn.rollback()
            logger.error("Schema init failed: %s", exc)
            raise
        finally:
            self._pool.putconn(conn)

    def table(self, name: str) -> QueryBuilder:
        return QueryBuilder(self._pool, name)
