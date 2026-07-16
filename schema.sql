-- ============================================================
-- AI Shipbroking Email Parser — PostgreSQL Schema
--
-- Source of truth: backend/pg_db.py (_SCHEMA_SQL). The backend runs this
-- automatically on startup (all statements are idempotent), so you normally
-- do NOT need to run this file by hand. It is kept in sync for reference and
-- for provisioning a fresh database manually in pgAdmin.
--
-- Target DB: `email_parser` (see backend/.env → PG_DATABASE)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- parent_emails — one row per owner email fetched from Gmail
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parent_emails (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject         TEXT NOT NULL,
    sender          TEXT NOT NULL DEFAULT '',
    date_received   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Status lifecycle: fetching → extracting → ready_for_validation → drafted
    status          TEXT NOT NULL DEFAULT 'fetching',
    message_id      TEXT UNIQUE,          -- Gmail Message-ID (dedup guard)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- attachments — one row per .eml (or file) attached to a parent email
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_email_id   UUID NOT NULL REFERENCES parent_emails(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL DEFAULT '',
    raw_text          TEXT,               -- Full extracted text from the attachment
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending → extracting → done | error
    error_message     TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_parent_email_id
    ON attachments(parent_email_id);

-- Owner-email metadata, stored file attachments, verification + preview (migration-safe)
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mail_from         TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mail_subject      TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mail_date         TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS files             JSONB DEFAULT '[]'::jsonb;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_emails  TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_phones  TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_verified       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS manually_reviewed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_html      TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_plain     TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_images    JSONB;

-- ─────────────────────────────────────────────
-- column_definitions — the ordered superset of grid columns
-- (seeded from backend/column_defs.py on startup)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS column_definitions (
    id              TEXT PRIMARY KEY,
    header          TEXT NOT NULL,
    display_order   INT NOT NULL,
    read_only       BOOLEAN NOT NULL DEFAULT FALSE,
    storage         TEXT NOT NULL DEFAULT 'dynamic_data'  -- dynamic_data | region | derived
);

-- ─────────────────────────────────────────────
-- vessels — one row per extracted vessel position
-- dynamic_data holds all standard column keys as JSONB
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vessels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    dynamic_data    JSONB NOT NULL DEFAULT '{}',
    region          TEXT,
    is_validated    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vessels_attachment_id ON vessels(attachment_id);
CREATE INDEX IF NOT EXISTS idx_vessels_region        ON vessels(region);
CREATE INDEX IF NOT EXISTS idx_vessels_dynamic_data  ON vessels USING GIN (dynamic_data);

-- ─────────────────────────────────────────────
-- broker_contacts — structured contacts parsed from email signatures
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_contacts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id     UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    parent_email_id   UUID REFERENCES parent_emails(id) ON DELETE CASCADE,
    contact_name      TEXT NOT NULL DEFAULT '',
    designation       TEXT NOT NULL DEFAULT '',
    department        TEXT NOT NULL DEFAULT '',
    company           TEXT NOT NULL DEFAULT '',
    company_type      TEXT NOT NULL DEFAULT '',
    vessel_name       TEXT NOT NULL DEFAULT '',
    email             TEXT NOT NULL DEFAULT '',
    off_phone         TEXT NOT NULL DEFAULT '',
    mob_phone         TEXT NOT NULL DEFAULT '',
    wechat            TEXT NOT NULL DEFAULT '',
    whatsapp          TEXT NOT NULL DEFAULT '',
    website_address   TEXT NOT NULL DEFAULT '',
    office_address    TEXT NOT NULL DEFAULT '',
    other_info        TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT '',
    used_fallback     BOOLEAN NOT NULL DEFAULT FALSE,
    row_order         INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_contacts_attachment_id
    ON broker_contacts(attachment_id);
CREATE INDEX IF NOT EXISTS idx_broker_contacts_parent_email_id
    ON broker_contacts(parent_email_id);

-- ─────────────────────────────────────────────
-- vessel_library — deduplicated master list of vessels (static particulars)
-- Auto-filled from vessels on first startup; managed from the UI thereafter.
-- match_key: "imo:<7-digit>" when an IMO number exists, else "name:<normalized name>"
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vessel_library (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vessel_name    TEXT NOT NULL DEFAULT '',
    imo_no         TEXT NOT NULL DEFAULT '',
    imo_type       TEXT NOT NULL DEFAULT '',
    dwt            TEXT NOT NULL DEFAULT '',
    year_built     TEXT NOT NULL DEFAULT '',
    tank_coating   TEXT NOT NULL DEFAULT '',
    vessel_type    TEXT NOT NULL DEFAULT '',
    match_key      TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vessel_library_match_key
    ON vessel_library(match_key);

-- ─────────────────────────────────────────────
-- vessels_full — vessels joined with parent/attachment context (grid queries)
-- ─────────────────────────────────────────────
DROP VIEW IF EXISTS vessels_full;
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
    pe.date_received,
    a.signature_emails,
    a.signature_phones,
    a.is_verified AS attachment_is_verified
FROM vessels v
JOIN attachments   a  ON a.id  = v.attachment_id
JOIN parent_emails pe ON pe.id = a.parent_email_id;
