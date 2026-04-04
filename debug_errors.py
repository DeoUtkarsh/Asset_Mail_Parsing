"""
Standalone diagnostic script — run manually to inspect failed attachments.

Usage (from project root):
    python debug_errors.py

No backend or UI needs to be running. Just needs PostgreSQL up.
"""
import sys
import os

# Allow importing from backend folder
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "backend", ".env"))

import psycopg2
from config import settings

# ── Connect ──────────────────────────────────────────────────────────────────
conn = psycopg2.connect(
    host=settings.PG_HOST,
    port=settings.PG_PORT,
    dbname=settings.PG_DATABASE,
    user=settings.PG_USER,
    password=settings.PG_PASSWORD,
)
cur = conn.cursor()

print("=" * 70)
print("  DIAGNOSTIC REPORT — Failed / Error Attachments")
print("=" * 70)

# ── 1. Summary of all attachment statuses ────────────────────────────────────
print("\n[1] ATTACHMENT STATUS SUMMARY")
print("-" * 40)
cur.execute("""
    SELECT status, COUNT(*) AS count
    FROM attachments
    GROUP BY status
    ORDER BY count DESC
""")
for row in cur.fetchall():
    print(f"  {row[0]:<25} {row[1]} file(s)")

# ── 2. Error attachments — full details ──────────────────────────────────────
print("\n[2] ERROR ATTACHMENTS — DETAILS")
print("-" * 40)
cur.execute("""
    SELECT id, filename, error_message, LENGTH(raw_text) AS raw_len
    FROM attachments
    WHERE status = 'error'
    ORDER BY filename
""")
errors = cur.fetchall()

if not errors:
    print("  No error attachments found.")
else:
    for att_id, filename, error_msg, raw_len in errors:
        print(f"\n  File     : {filename}")
        print(f"  ID       : {att_id}")
        print(f"  Error    : {error_msg}")
        print(f"  Raw text : {raw_len or 0} chars extracted")

# ── 3. Show first 1000 chars of raw text for each error attachment ────────────
if errors:
    print("\n[3] RAW TEXT PREVIEW (first 1000 chars each)")
    print("-" * 40)
    for att_id, filename, error_msg, raw_len in errors:
        cur.execute("SELECT raw_text FROM attachments WHERE id = %s", (att_id,))
        row = cur.fetchone()
        raw = (row[0] or "") if row else ""
        print(f"\n  ── {filename} ──")
        if raw:
            print(raw[:1000])
            if len(raw) > 1000:
                print(f"  ... [{len(raw) - 1000} more chars]")
        else:
            print("  [NO RAW TEXT — IMAP extraction may have failed]")

# ── 4. Vessels extracted per attachment ──────────────────────────────────────
print("\n[4] VESSEL COUNT PER ATTACHMENT")
print("-" * 40)
cur.execute("""
    SELECT a.filename, a.status, COUNT(v.id) AS vessel_count
    FROM attachments a
    LEFT JOIN vessels v ON v.attachment_id = a.id
    GROUP BY a.id, a.filename, a.status
    ORDER BY a.filename
""")
for filename, status, count in cur.fetchall():
    marker = " ← ERROR" if status == "error" else ""
    print(f"  {filename:<30} {status:<12} {count} vessel(s){marker}")

# ── 5. Total vessels in DB ────────────────────────────────────────────────────
cur.execute("SELECT COUNT(*) FROM vessels")
total = cur.fetchone()[0]
print(f"\n  TOTAL VESSELS IN DB: {total}")
print("=" * 70)

cur.close()
conn.close()
