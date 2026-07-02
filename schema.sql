-- ============================================================
-- AI Shipbroking Email Parser — PostgreSQL Schema
-- Run this in pgAdmin Query Tool on the 'email_parser' database.
-- (The backend also runs this automatically on startup via pg_db.py)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- Table 1: parent_emails
-- One row per email fetched from Gmail
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parent_emails (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject             TEXT NOT NULL,
    sender              TEXT NOT NULL DEFAULT '',
    date_received       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Status lifecycle:
    -- fetching → extracting → ready_for_validation → drafted
    status              TEXT NOT NULL DEFAULT 'fetching',
    message_id          TEXT UNIQUE,          -- Gmail Message-ID header (dedup guard)
    signature_emails    TEXT,                 -- Legacy; signatures live on attachments now
    signature_phones    TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Table 2: attachments
-- One row per .eml file attached to a parent email
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_email_id   UUID NOT NULL REFERENCES parent_emails(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL DEFAULT '',
    raw_text          TEXT,               -- Flattened text for LLM extraction
    preview_html      TEXT,               -- Original HTML body for preview (sanitized)
    preview_plain     TEXT,               -- Original plain-text body for preview
    preview_images    JSONB,              -- Inline images [{mime, data_url}] for screenshot mails
    signature_emails  TEXT,               -- Broker emails for this attachment only
    signature_phones  TEXT,               -- Broker phones for this attachment only
    -- Status: pending → extracting → done | error
    status            TEXT NOT NULL DEFAULT 'pending',
    error_message     TEXT,               -- Populated if extraction fails
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachments_parent_email_id
    ON attachments(parent_email_id);

-- ─────────────────────────────────────────────
-- Table 3: vessels
-- One row per vessel extracted from an attachment
-- One attachment may produce 1–20+ vessel rows
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vessels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attachment_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    -- JSONB holds all dynamic columns (dwt, built, coating, etc.)
    -- Keys are normalised by Agent 3 to a superset schema
    dynamic_data    JSONB NOT NULL DEFAULT '{}',
    region          TEXT,                 -- Extracted geographical area; used for grouping in draft
    is_validated    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vessels_attachment_id
    ON vessels(attachment_id);

CREATE INDEX IF NOT EXISTS idx_vessels_region
    ON vessels(region);

CREATE INDEX IF NOT EXISTS idx_vessels_dynamic_data
    ON vessels USING GIN (dynamic_data);

-- ─────────────────────────────────────────────
-- Table 4: column_definitions
-- Grid headers — source of truth for UI + API
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS column_definitions (
    id              TEXT PRIMARY KEY,
    header          TEXT NOT NULL,
    display_order   INT NOT NULL,
    read_only       BOOLEAN NOT NULL DEFAULT FALSE,
    storage         TEXT NOT NULL DEFAULT 'dynamic_data'
);

-- ─────────────────────────────────────────────
-- Upgrade path: add signature columns on existing installs
-- ─────────────────────────────────────────────
ALTER TABLE parent_emails ADD COLUMN IF NOT EXISTS signature_emails TEXT;
ALTER TABLE parent_emails ADD COLUMN IF NOT EXISTS signature_phones TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_emails TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_phones TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS manually_reviewed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS review_baseline JSONB;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_html TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_plain TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS preview_images JSONB;

-- ─────────────────────────────────────────────
-- Table 5: broker_contacts
-- Structured contact rows per attachment (from LLM + fallback)
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

-- ETA FOC column (after FLAG, before REGION) — idempotent via sync_column_definitions on API startup
INSERT INTO column_definitions (id, header, display_order, read_only, storage)
VALUES ('eta_foc', 'ETA FOC', 11, FALSE, 'dynamic_data')
ON CONFLICT (id) DO UPDATE SET header = EXCLUDED.header, display_order = EXCLUDED.display_order;
UPDATE column_definitions SET display_order = 12 WHERE id = 'region';
UPDATE column_definitions SET display_order = 13 WHERE id = 'open_location';
UPDATE column_definitions SET display_order = 14 WHERE id = 'opening_date';
UPDATE column_definitions SET display_order = 15 WHERE id = 'cargo_history_combo';
UPDATE column_definitions SET display_order = 16 WHERE id = 'tank_coating';
UPDATE column_definitions SET display_order = 17 WHERE id = 'sire_date';
UPDATE column_definitions SET display_order = 18 WHERE id = 'sire_location';
UPDATE column_definitions SET display_order = 19 WHERE id = 'cdi_date';
UPDATE column_definitions SET display_order = 20 WHERE id = 'cdi_location';
UPDATE column_definitions SET display_order = 21 WHERE id = 'remarks';
UPDATE column_definitions SET display_order = 22 WHERE id = 'other_info';
UPDATE column_definitions SET display_order = 23 WHERE id = 'q88';
UPDATE column_definitions SET display_order = 24 WHERE id = 'attachments';
UPDATE column_definitions SET display_order = 25 WHERE id = 'status';

-- ─────────────────────────────────────────────
-- Convenience view: vessels with parent context
-- Useful for the validation grid query
-- ─────────────────────────────────────────────
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
