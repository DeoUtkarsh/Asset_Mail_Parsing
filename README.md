# AI-Powered Shipbroking Email Parser

An agentic system that fetches owner **position-list emails** from Gmail, extracts vessel
data with NVIDIA NIM LLMs, lets you review/verify it in an Outlook-style workspace, keeps a
deduplicated **vessel library**, and generates a polished, zone-grouped position-list email
draft — all running **locally** against a PostgreSQL database.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Agent framework | LangGraph (Phase 1 + Phase 2 graphs) |
| LLM | NVIDIA NIM (extraction, drafting, summaries) |
| Database | **Local PostgreSQL** (via `psycopg2`, managed in pgAdmin) |
| Real-time | Server-Sent Events (`sse-starlette`) |
| Frontend | React 18 + Vite + TailwindCSS |
| Data grid | TanStack Table v8 |
| Map / PDF | Leaflet, jsPDF + autotable, html2canvas |

> The DB layer exposes a Supabase-style client (`pg_db.py`) so all agents use the same
> `supabase.table(...)` API, but everything is backed by your **local Postgres** — no cloud.

---

## Application Flow

```
Gmail (IMAP)
   │  ⬇ Sync
   ▼
[Phase 1 — LangGraph]  ingestion → extraction (parallel NVIDIA calls) → normalization
   │                    then: signature extraction + contact extraction
   ▼
PostgreSQL  (parent_emails · attachments · vessels · broker_contacts · vessel_library)
   │
   ▼
React workspace (6 tabs)
   │  select + verify vessels
   ▼
[Phase 2 — LangGraph]  drafter → zone-grouped HTML/grid draft → copy / PDF
```

### The workspace tabs

1. **Home** — AI dashboard: pipeline stepper (Received → Parsed → Compiled → Review),
   readiness ring, "need to review" / positions counts, and agent cards.
2. **Vessel Extracted Data** — Outlook-style two-pane inbox. Left: one card per attachment
   (sender, subject, date, status, confidence, verified). Right: inline editable vessel grid
   + original email body, with **Edit / Save / Verify** and an **All columns** toggle.
3. **Need to Review** — same layout as above, filtered to attachments with **medium/low
   confidence** or **failed extraction**.
4. **Vessel Position List** — the consolidated grid of **verified** vessels across all emails.
   Supports inline edit, column selection, **Add position** (manual entry with all columns),
   and **Draft Email** generation (map + zone-grouped draft, copy / PDF).
5. **Contact List** — structured broker contacts parsed from signatures (editable, CSV export).
6. **Vessel Libraries List** — deduplicated master list of vessels (name, DWT, year built,
   tank coating, IMO type, IMO no., vessel type). Auto-filled from the DB; add/edit/delete
   vessels manually; review **🆕 newly detected** vessels before adding them to the library.

---

## One-Time Setup

### 1. PostgreSQL (pgAdmin)

1. Install PostgreSQL + pgAdmin and start the server.
2. Create a database named **`email_parser`** (or set your own via `PG_DATABASE`).
3. Schema is created **automatically** by the backend on startup (idempotent DDL in
   `backend/pg_db.py`). To provision manually instead, run `schema.sql` in the pgAdmin Query Tool.

### 2. Backend

```powershell
cd backend

# Copy the example env file and fill in your credentials
copy .env.example .env
# Edit .env: Gmail (EMAIL_*), NVIDIA (NVIDIA_*), and PostgreSQL (PG_*)

# Create + activate a virtualenv
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

## Running the App

Open **two terminals**.

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
App: `http://localhost:5173` (Vite proxies `/api` → `localhost:8000`).

---

## Usage Flow

1. **Sync** — pulls owner emails via IMAP, saves attachments, and runs Phase 1 extraction
   (parallel NVIDIA calls) plus signature/contact extraction. Live progress streams via SSE.
2. **Review** — open **Vessel Extracted Data** (or **Need to Review**), click an attachment,
   check the extracted grid against the original email, fix any amber-highlighted cells,
   then **Verify**. Verified vessels flow into the **Vessel Position List**.
3. **Compile & Draft** — on **Vessel Position List**, select vessels + columns and click
   **Draft Email**. Review the zone map and generated draft, then **Copy** or **Download PDF**.
4. **Maintain the library** — **Vessel Libraries List** stays in sync: add vessels manually,
   or promote newly detected vessels from the review panel.

---

## Utility Scripts

```powershell
# From backend/ — (re)populate the vessel library from vessels already in the DB.
# Idempotent: only inserts vessels not already present (matched by IMO, else name).
python -m scripts.autofill_vessel_library
```
(The same auto-fill runs automatically on first startup when the library is empty, and is
also exposed at `POST /api/vessel-library/autofill`.)

---

## AWS Deployment

Full step-by-step runbook: **[docs/aws-deployment/README.md](docs/aws-deployment/README.md)**
(Phases 0–7: Docker, ECR + secrets, VPC, RDS, ECS + ALB, S3 + CloudFront, hardening,
future improvements — plus troubleshooting and a prod cutover checklist).

The backend ships with a container image (`backend/Dockerfile` + `backend/.dockerignore`) —
the **same image runs locally under Docker and on AWS ECS**:

```powershell
cd backend
docker build -t email-parser-backend .
docker run --env-file .env -p 8000:8000 email-parser-backend
```

---

## Project Structure

```
Email_Parser_Two/
├── schema.sql                     ← Reference DDL (auto-applied by the backend on startup)
├── README.md
├── .gitignore
├── backend/
│   ├── .env.example               ← Copy to .env and fill in secrets
│   ├── requirements.txt
│   ├── main.py                    ← FastAPI app + all routes
│   ├── config.py                  ← Pydantic settings (reads .env)
│   ├── database.py                ← DB client singleton (PostgreSQL)
│   ├── pg_db.py                   ← Supabase-style client + schema DDL (source of truth)
│   ├── models.py                  ← Pydantic request/response models
│   ├── column_defs.py             ← Standard columns + legacy→standard mapping
│   ├── verification.py            ← Attachment verify / send-to-position-list logic
│   ├── vessel_library.py          ← Vessel library: autofill / list / detect-new / CRUD
│   ├── imap_client.py             ← Gmail IMAP + .eml text extraction
│   ├── sse_manager.py             ← SSE event broadcaster
│   ├── workflow.py                ← LangGraph Phase 1 + Phase 2 graphs
│   ├── scripts/
│   │   └── autofill_vessel_library.py
│   └── agents/
│       ├── ingestion.py           ← Fetch & save emails/attachments
│       ├── extraction.py          ← Parallel NVIDIA extraction
│       ├── normalization.py       ← Superset column builder
│       ├── drafter.py             ← Zone-grouped draft generator
│       ├── signature_extract.py   ← Signature emails/phones
│       ├── contact_extract.py     ← Structured broker contacts
│       ├── confidence_score.py    ← Per-attachment confidence tiers
│       └── summary.py             ← AI summaries (home / inbox / vessels / contacts)
└── frontend/
    ├── package.json
    ├── vite.config.js             ← Proxy /api → localhost:8000
    └── src/
        ├── App.jsx                ← Shell, rail nav, routing, global state
        ├── services/api.js        ← All fetch() calls to the backend
        ├── hooks/useSSE.js        ← EventSource hook
        ├── lib/positions.js       ← Position helpers (confidence, grouping)
        ├── utils/                 ← columns, CSV/PDF export, map bounds, previews
        └── components/
            ├── HomeView/          ← Home dashboard
            ├── InboxView/         ← Vessel Extracted Data + Need to Review (PreviewPanel)
            ├── ValidationView/    ← Vessel Position List (EditableGrid, DraftModal)
            ├── DraftView/         ← Map + generated draft
            ├── ContactListView/   ← Contact List
            ├── VesselLibraryView/ ← Vessel Libraries List
            ├── AiSummary/         ← Shared AI summary button + modal
            ├── pages/             ← Settings, EmailDetail
            └── icons.jsx
```

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `EMAIL_USER` | Your Gmail address |
| `EMAIL_PASSWORD` | Gmail **App Password** (16 chars, not your login password) |
| `IMAP_SERVER` / `IMAP_PORT` | `imap.gmail.com` / `993` |
| `FILTER_SENDER` | Only fetch emails from this address |
| `TARGET_SUBJECT` | Subject substring to match |
| `NVIDIA_API_KEY` | Your NVIDIA NIM API key |
| `NVIDIA_API_BASE_URL` | NVIDIA base URL (default `https://integrate.api.nvidia.com/v1`) |
| `NVIDIA_LLM_MODEL` | Model for extraction / drafting / summaries |
| `NVIDIA_PARSE_MODEL` | Model for document parsing |
| `PG_HOST` / `PG_PORT` | PostgreSQL host / port (default `localhost` / `5432`) |
| `PG_DATABASE` | Database name (default `email_parser`) |
| `PG_USER` / `PG_PASSWORD` | PostgreSQL credentials |
| `MAX_ATTACHMENTS` | Cap attachments processed per run (`0` = all) |

---

## Gmail App Password

Standard Gmail passwords don't work with IMAP. Create a **16-character App Password**:

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security).
2. Enable **2-Step Verification**.
3. Under **App Passwords**, create one for "Mail".
4. Paste the 16-character code (no spaces) as `EMAIL_PASSWORD` in `.env`.
