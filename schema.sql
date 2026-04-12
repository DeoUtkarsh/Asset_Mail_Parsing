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
    raw_text          TEXT,               -- Full extracted text from the .eml file
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
-- Upgrade path: add signature columns on existing installs
-- ─────────────────────────────────────────────
ALTER TABLE parent_emails ADD COLUMN IF NOT EXISTS signature_emails TEXT;
ALTER TABLE parent_emails ADD COLUMN IF NOT EXISTS signature_phones TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_emails TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS signature_phones TEXT;

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
    a.signature_phones
FROM vessels v
JOIN attachments   a  ON a.id  = v.attachment_id
JOIN parent_emails pe ON pe.id = a.parent_email_id;
