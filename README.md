# AI-Powered Shipbroking Email Parser (Broker Sense)

An agentic system that fetches owner **position-list emails** from Gmail (IMAP), extracts
vessel data with **Anthropic Claude** (text + vision + PDF), lets you review/verify it in an
Outlook-style workspace, keeps a deduplicated **vessel library**, and generates a polished,
zone-grouped position-list email draft.

Runs **locally** against PostgreSQL, or on **AWS** (ECS + RDS + S3 + CloudFront) using the
same Docker image and schema.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Agent framework | LangGraph (Phase 1 + Phase 2 graphs) |
| LLM | **Anthropic Claude** (`ANTHROPIC_API_KEY` / `CLAUDE_MODEL`) |
| Database | PostgreSQL (`psycopg2`; local pgAdmin or AWS RDS) |
| Attachment files | Local `attachment_files/` **or** **S3** when `ATTACHMENTS_S3_BUCKET` is set |
| Real-time | Server-Sent Events (`sse-starlette`) — **1 process / 1 ECS task** |
| Frontend | React 18 + Vite + TailwindCSS |
| Data grid | TanStack Table v8 |
| Map / PDF | Leaflet, jsPDF + autotable, html2canvas |

> The DB layer exposes a Supabase-style client (`pg_db.py`) so agents use
> `supabase.table(...)`, but storage is always **your Postgres** — no Supabase cloud.

---

## Application Flow

```
Gmail (IMAP)
   │  ⬇ Fetch Emails (new Message-IDs only; MAX_ATTACHMENTS=0 → all new)
   ▼
[Phase 1 — LangGraph]  ingestion → Claude extraction (parallel) → normalization
   │                    then: signature + contact extraction
   │                    files → local disk or S3
   ▼
PostgreSQL  (parent_emails · attachments · vessels · broker_contacts · vessel_library · …)
   │
   ▼
React workspace (Broker Sense)
   │  review / verify / position list
   ▼
[Phase 2 — LangGraph]  drafter → zone-grouped HTML/grid draft → copy / PDF
```

### Workspace tabs

1. **Home** — AI dashboard: pipeline stepper, readiness, review / positions counts, agent cards.
2. **Vessel Extracted Data** — Outlook-style inbox + editable vessel grid + original message.
3. **Need to Review** — medium/low confidence or failed extractions (helper: review medium & low confidence mail).
4. **Vessel Position List** — verified vessels; select vessels/columns → **Draft Email** (map + zone PDF).  
   Helper line: *Select vessel and click on draft mail, your position list is ready to send.*
5. **Contact List** — broker contacts from signatures.
6. **Vessel Libraries List** — deduplicated vessel master + “newly detected” review / **Review all**.

### Editing notes (Position List · Extraction · Need to Review)

- Click **Edit** to change cells; **Save changes** persists.
- **REGION** and **VESSEL TYPE** use a shared combobox (pick from list or type free text; **Others** focuses free text).
- **Company** is resolved from subject, email domains, and contacts when the mail does not spell it out (e.g. Shell position lists).
- **Extra Info** keeps full leftover vessel particulars from extraction (not truncated stubs).
- Vessel Library tables stay read-only; edit only via Add / Edit / Review modals (same vessel-type combobox).

---

## One-Time Setup (local)

### 1. PostgreSQL (pgAdmin)

1. Install PostgreSQL + pgAdmin and start the server.
2. Create a database (e.g. **`email_parser_dev`** — see `backend/.env.example`).
3. Schema is created **automatically** on backend startup (`backend/pg_db.py`).  
   Optional manual DDL: run root `schema.sql` in the Query Tool.

### 2. Backend

```powershell
cd backend

copy .env.example .env
# Edit .env: EMAIL_*, ANTHROPIC_*, PG_*
# Leave ATTACHMENTS_S3_BUCKET empty for local disk storage

python -m venv ..\venv
..\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. Frontend

```powershell
cd frontend
npm install
```

---

## Running locally

**Terminal 1 — Backend**
```powershell
cd backend
..\venv\Scripts\Activate.ps1
uvicorn main:app --reload --port 8000
```
API: `http://localhost:8000` · Docs: `http://localhost:8000/docs`

**Terminal 2 — Frontend**
```powershell
cd frontend
npm run dev
```
App: `http://localhost:5173` (Vite proxies `/api` → `:8000`).

---

## Usage Flow

1. **Fetch Emails** — IMAP pull of **new** broker mail; Phase 1 extraction + contacts; SSE progress.
2. **Review** — fix amber (missing) / blue (AI-normalized) cells; use REGION / VESSEL TYPE comboboxes in Edit mode; **Verify**.
3. **Draft** — on Vessel Position List, select vessels + columns → **Draft Email** → map + zone-grouped copy / PDF.
4. **Library** — Vessel Libraries List: Add / Edit / Review / **Review all** (autofill from extracted vessels).

### Clear data (keep tables + column headers + region reference)

Clears emails, attachments, vessels, contacts (and optionally `vessel_library`).  
**Does not** wipe `column_definitions` or trade geo tables (`trade_regions`, `trade_ports`, `open_location_aliases`).

```powershell
cd backend
..\venv\Scripts\Activate.ps1
python -m scripts.reset_data --yes
# also clear vessel_library:
python -m scripts.reset_data --library --yes
```

Equivalent SQL (e.g. on RDS / pgAdmin):

```sql
TRUNCATE parent_emails, attachments, vessels, broker_contacts, vessel_library
RESTART IDENTITY CASCADE;

-- Check region seed still present:
SELECT
  (SELECT COUNT(*) FROM trade_regions) AS regions,
  (SELECT COUNT(*) FROM trade_ports) AS ports,
  (SELECT COUNT(*) FROM open_location_aliases) AS aliases;
```

---

## AWS Deployment

Live **dev** app: **https://d2bt5vx8sl8jq9.cloudfront.net**

Full runbook: **[docs/aws-deployment/README.md](docs/aws-deployment/README.md)**  
Phases 0–8: Docker → ECR + secrets → VPC → RDS → ECS/ALB → UI (S3/CloudFront) → harden → **attachment S3**.

Same image locally and on ECS:

```powershell
cd backend
docker build -t email-parser-api:local .
docker run --rm -p 8000:8000 --env-file .env -e PG_HOST=host.docker.internal email-parser-api:local
```

`.dockerignore` excludes `.env` and local `attachment_files/` (files are not baked into the image).

---

## Project Structure

```
Email_Parser_Two/
├── schema.sql                     ← Reference DDL (also applied by backend on startup)
├── README.md
├── docs/aws-deployment/           ← AWS runbook (source of truth for deploy)
├── backend/
│   ├── .env.example
│   ├── Dockerfile / .dockerignore
│   ├── requirements.txt           ← includes anthropic, boto3, httpx==0.27.2
│   ├── main.py                    ← FastAPI routes
│   ├── config.py                  ← Pydantic settings
│   ├── file_storage.py            ← Local disk or S3 for attachment binaries
│   ├── database.py / pg_db.py
│   ├── column_defs.py / verification.py / vessel_library.py
│   ├── region_map.py / region_geo.py   ← standard regions from open_location + DB seed
│   ├── imap_client.py / sse_manager.py / workflow.py / llm.py
│   ├── scripts/
│   │   ├── reset_data.py              ← wipe fetch/extract rows (keeps headers + geo)
│   │   ├── autofill_vessel_library.py
│   │   └── preview_inbox.py           ← IMAP keep/skip dry-run (no LLM)
│   └── agents/
│       ├── ingestion.py / extraction.py / normalization.py
│       ├── drafter.py / signature_extract.py / contact_extract.py
│       ├── confidence_score.py / summary.py
│       └── …
└── frontend/
    ├── vite.config.js             ← Proxy /api; allowedHosts for ngrok
    └── src/
        ├── components/            ← views, EditableGrid, RegionSelect, VesselTypeSelect
        └── utils/                 ← standardColumns, regionOptions, downloadDraftPdf
```

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `EMAIL_USER` / `EMAIL_PASSWORD` | Mailbox + Gmail **App Password** |
| `IMAP_SERVER` / `IMAP_PORT` | Default `imap.gmail.com` / `993` |
| `BLOCKED_SENDER_PATTERNS` | Comma-separated From substrings to skip (noreply, etc.) |
| `ANTHROPIC_API_KEY` | Anthropic API key (**required**) |
| `CLAUDE_MODEL` | e.g. `claude-haiku-4-5` |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | Postgres |
| `MAX_ATTACHMENTS` | Cap new emails per fetch (`0` = all new) |
| `ATTACHMENTS_S3_BUCKET` | Empty = local `attachment_files/`; set on AWS for durable storage |
| `ATTACHMENTS_S3_PREFIX` | Default `attachment_files` |
| `AWS_REGION` | e.g. `ap-southeast-1` (used by boto3 when S3 is enabled) |

Legacy / unused by current code (safe to leave in old secrets): `FILTER_SENDER`, `TARGET_SUBJECT`, `NVIDIA_*`.

---

## Gmail App Password

1. [Google Account → Security](https://myaccount.google.com/security)  
2. Enable **2-Step Verification**  
3. Create an **App Password** for Mail  
4. Paste the 16-character code as `EMAIL_PASSWORD` (no spaces)
