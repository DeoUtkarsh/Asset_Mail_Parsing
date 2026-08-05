# AI-Powered Shipbroking Email Parser (Shipbroker Sense)

> **Branch:** `aws-deployment` — deploy / AWS source of truth.  
> Local IDLE defaults **off** here (`AUTO_FETCH_IMAP_IDLE=false`). On ECS set it **true** in Secrets Manager.  
> Day-to-day feature work may also live on `feature/frontend-redesign` (IDLE on by default for local testing).

An agentic system that fetches owner **position-list emails** from Gmail (IMAP), extracts
vessel data with **Anthropic Claude** (text + vision + PDF), lets you review/verify it in an
Outlook-style workspace, keeps a deduplicated **vessel library** (with post-extract **web enrichment**),
and generates a polished, zone-grouped position-list email draft.

Runs **locally** against PostgreSQL, or on **AWS** (ECS + RDS + S3 + CloudFront) using the
same Docker image and schema.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Agent framework | LangGraph (Phase 1 + Phase 2 graphs) |
| LLM | **Anthropic Claude** (`ANTHROPIC_API_KEY` / `CLAUDE_MODEL`) |
| Vessel enrichment | Claude + Anthropic **`web_search`** server tool (no VesselAPI / MyShip keys) |
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
   │  ⬇ Fetch Emails  (and/or IMAP IDLE auto-fetch on AWS)
   │     new Message-IDs only; MAX_ATTACHMENTS=0 → all new
   ▼
[Phase 1 — LangGraph]
   ingestion → Claude extraction (parallel) → normalization
   then: signature + contact extraction
   files → local disk or S3
   │
   │  SSE: phase1_complete  ← inbox / Home / sync spinner STOP here
   ▼
PostgreSQL
   parent_emails · attachments · vessels · broker_contacts
   vessel_library · vessel_enrichment_cache · …
   │
   │  [Vessel library enrichment — AFTER Phase 1]
   │  Claude + web_search fills blank IMO / call sign / type / flag
   │  SSE: vessel_library_enrichment_started → … → done
   │  Spinner only on Vessel Libraries List (does not block inbox)
   ▼
React workspace (Shipbroker Sense)
   Home (today-scoped Morning Brief) · Inbox · Position List · Contacts · Library
   │
   ▼
[Phase 2 — LangGraph]  drafter → zone-grouped HTML/grid draft → copy / PDF
```

### Workspace tabs

1. **Home** — AI **Morning Brief** for **today** (calendar day + tz), review / positions-ready counts, agent cards.
2. **Vessel Extracted Data** — Outlook-style inbox (**All mails** / **Need to review**), day navigation, editable vessel grid + original message. Inbox KPIs (Emails / Synced / Vessels) follow the **selected day**.
3. **Vessel Position List** — verified vessels; select vessels/columns → **Draft Email** (map + zone PDF).  
   Helper line: *Select vessel and click on draft mail, your position list is ready to send.*
4. **Contact List** — unique broker people (not one row per mail). **Status** Active/Inactive (Edit → dropdown, default Active).
5. **Vessel Libraries List** — deduplicated vessel master + “New to review”. After each fetch, blank particulars may fill via web enrichment; **light yellow** cells + legend mark enriched fields.

### Unique identity (library + contacts)

- **Vessel library** — same ship = one row. Match by **IMO (7 digits)** first; else normalized name (strips `MT`/`MV`/`M/T`/`M/V`) plus year / DWT / type / IMO type when present. Soft-merge when name matches and particulars do not conflict. Sister ships (same name, different year/DWT) stay separate rows.
- **Enrichment** — after Phase 1 only; fills blanks (`imo_no`, `call_sign`, `vessel_type`, `flag`); never overwrites non-empty user/extracted values. Results cached in `vessel_enrichment_cache` and flagged in `api_sourced` for the yellow UI.
- **Contact list** — match by **email** → else **phone** → else **name + company**. User **Inactive** is kept on later extracts.
- **Position list / extracted vessels** stay per-email operational rows; the masters above are the deduped lists.

### Editing notes (Position List · Extracted Data tabs)

- Click **Edit** to change cells; **Save changes** persists.
- **REGION** and **VESSEL TYPE** use a shared combobox (pick from list or type free text; **Others** focuses free text).
- **Company** is resolved from subject, email domains, and contacts when the mail does not spell it out.
- **Extra Info** keeps full leftover vessel particulars from extraction.
- Vessel Library tables stay read-only in the grid; edit via Add / Edit / Review modals.
- Contact List: **Edit** for Status and other fields; all columns always visible.

---

## One-Time Setup (local)

### 1. PostgreSQL (pgAdmin)

1. Install PostgreSQL + pgAdmin and start the server.
2. Create a database (e.g. **`email_parser_dev`** — see `backend/.env.example`).
3. Schema is created **automatically** on backend startup (`backend/pg_db.py`), including `vessel_enrichment_cache` and `vessel_library.api_sourced`.  
   Optional manual DDL: root `schema.sql`.

### 2. Backend

```powershell
cd backend

copy .env.example .env
# Edit .env: EMAIL_*, ANTHROPIC_*, PG_*
# Leave ATTACHMENTS_S3_BUCKET empty for local disk storage
# On this branch keep AUTO_FETCH_IMAP_IDLE=false unless you want live IDLE locally

python -m venv ..\venv
..\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Anthropic account must allow **web search** (server tool) for library enrichment. Extraction still works without it; enrichment will log errors / skip.

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

1. **Fetch Emails** — IMAP pull of **new** broker mail (optional date range); Phase 1 extraction + contacts; SSE progress. Sync toast when Phase 1 completes.
2. **(Automatic) Library enrichment** — starts **after** Phase 1; open **Vessel Libraries List** to see the enrichment banner; yellow cells appear as blanks fill.
3. **Review** — inbox **Need to review** (or Home → Review now); fix amber / blue cells; **Verify**.
4. **Draft** — Vessel Position List → select vessels + columns → **Draft Email** → map + zone-grouped copy / PDF.
5. **Contacts** — one row per person; Edit → Status; Export CSV.
6. **Library** — Add / Edit / Review / **Review all** (autofill upserts by IMO / particulars).

### Clear data (keep tables + column headers + region reference)

Clears emails, attachments, vessels, contacts (and optionally `vessel_library`).  
**Does not** wipe `column_definitions` or trade geo tables.

```powershell
cd backend
..\venv\Scripts\Activate.ps1
python -m scripts.reset_data --yes
# also clear vessel_library:
python -m scripts.reset_data --library --yes
```

Equivalent SQL:

```sql
TRUNCATE parent_emails, attachments, vessels, broker_contacts, vessel_library,
         vessel_enrichment_cache
RESTART IDENTITY CASCADE;
```

---

## AWS Deployment

Live **dev** app: **https://d2bt5vx8sl8jq9.cloudfront.net**

Full runbook: **[docs/aws-deployment/README.md](docs/aws-deployment/README.md)**  
Phases 0–8: Docker → ECR + secrets → VPC → RDS → ECS/ALB → UI (S3/CloudFront) → harden → **attachment S3**.

**Deploy from this branch (`aws-deployment`).** Redeploy: build/push ECR image → force ECS deployment → `npm run build` → S3 sync → CloudFront invalidation `/*`.

Secrets already needed: `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (enrichment reuses them — **no new secret keys** for VesselAPI/MyShip).

On ECS set:

```text
AUTO_FETCH_IMAP_IDLE=true
```

IDLE records the current highest IMAP UID on startup and only auto-ingests mail that arrives **after** that baseline. Historical backfill = manual **Fetch Emails** + date range.

Same image locally and on ECS:

```powershell
cd backend
docker build -t email-parser-api:local .
docker run --rm -p 8000:8000 --env-file .env -e PG_HOST=host.docker.internal email-parser-api:local
```

`.dockerignore` excludes `.env` and local `attachment_files/`.

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
│   ├── requirements.txt
│   ├── main.py                    ← FastAPI routes + Phase-1 → enrichment hook
│   ├── config.py                  ← Pydantic settings
│   ├── file_storage.py            ← Local disk or S3 for attachment binaries
│   ├── database.py / pg_db.py
│   ├── vessel_library.py
│   ├── vessel_enrichment.py       ← Claude web_search library enrichment
│   ├── imap_client.py / imap_idle_watcher.py / imap_uid_watermark.py
│   ├── fetch_scope.py / sse_manager.py / workflow.py / llm.py
│   ├── scripts/
│   │   ├── reset_data.py
│   │   └── autofill_vessel_library.py
│   └── agents/
│       ├── ingestion.py / extraction.py / normalization.py
│       ├── drafter.py / signature_extract.py / contact_extract.py
│       ├── confidence_score.py / summary.py
│       └── …
└── frontend/
    ├── vite.config.js
    └── src/
        ├── App.jsx                ← Home refresh, library enriching SSE
        ├── lib/calendarDay.js     ← today / day-nav calendar helpers
        ├── components/            ← Home, Inbox, Library, DateRangePicker, …
        └── utils/
```

Startup rematch: on boot the API recomputes vessel-library and contact `match_key`s and merges soft duplicates (no autofill insert into the library until you **Review all**).

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `EMAIL_USER` / `EMAIL_PASSWORD` | Mailbox + Gmail **App Password** |
| `IMAP_SERVER` / `IMAP_PORT` | Default `imap.gmail.com` / `993` |
| `BLOCKED_SENDER_PATTERNS` | Comma-separated From substrings to skip |
| `ANTHROPIC_API_KEY` | Anthropic API key (**required** — extraction + enrichment) |
| `CLAUDE_MODEL` | e.g. `claude-haiku-4-5` |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | Postgres |
| `MAX_ATTACHMENTS` | Cap new emails per fetch (`0` = all new) |
| `AUTO_FETCH_IMAP_IDLE` | `false` locally on this branch; **`true` on ECS** |
| `AUTO_FETCH_IDLE_RECONNECT_SEC` | IDLE reconnect pause (default `30`) |
| `ATTACHMENTS_S3_BUCKET` | Empty = local `attachment_files/`; set on AWS |
| `ATTACHMENTS_S3_PREFIX` | Default `attachment_files` |
| `AWS_REGION` | e.g. `ap-southeast-1` when S3 is enabled |

Legacy / ignored: `FILTER_SENDER`, `TARGET_SUBJECT`, `NVIDIA_*`, `VESSELAPI_*`, `MYSHIPTRACKING_*`.

---

## Gmail App Password

1. [Google Account → Security](https://myaccount.google.com/security)  
2. Enable **2-Step Verification**  
3. Create an **App Password** for Mail  
4. Paste the 16-character code as `EMAIL_PASSWORD` (no spaces)
