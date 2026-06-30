# AI-Powered Shipbroking Email Parser

Agentic pipeline that fetches `.eml` attachments from Gmail (IMAP), extracts vessel position rows with **NVIDIA NIM**, stores everything in **PostgreSQL**, and serves a **three-tab React UI**: Email Data → Vessel Position List → Contact List. Draft output opens in a **map + grid modal** on the validation tab. Real-time progress uses **Server-Sent Events (SSE)**.

Repository: [github.com/DeoUtkarsh/Asset_Mail_Parsing](https://github.com/DeoUtkarsh/Asset_Mail_Parsing)

---

## Architecture (high level)

```mermaid
flowchart TB
  subgraph client [Browser — Vite React]
    UI[Email Data / Vessel Position List / Contact List]
    Modal[Map and Draft modal]
    SSEHook[useSSE — EventSource]
    APIjs[api.js — fetch /api/*]
  end

  subgraph vite [Vite dev server :5173]
    Proxy["proxy /api → localhost:8000"]
  end

  subgraph backend [FastAPI :8000]
    Routes[REST + SSE routes]
    LG1[LangGraph Phase 1]
    LG2[LangGraph Phase 2]
    A1[ingestion]
    A2[extraction — NVIDIA LLM + vertical parser]
    A3[normalization]
    A4[drafter — grid-aligned HTML + intro LLM]
    Sig[signature_extract]
  end

  subgraph external [External services]
    Gmail[IMAP Gmail]
    NIM[NVIDIA NIM API]
  end

  subgraph data [Data]
    PG[(PostgreSQL)]
  end

  UI --> APIjs
  UI --> SSEHook
  Modal --> APIjs
  APIjs --> Proxy --> Routes
  SSEHook --> Routes
  Routes --> LG1
  Routes --> LG2
  LG1 --> A1 --> A2 --> A3
  LG1 --> Sig
  LG2 --> A4
  A1 --> Gmail
  A2 --> NIM
  A4 --> NIM
  Sig --> NIM
  A1 & A2 & A3 & A4 & Sig --> PG
```

---

## End-to-end flow

1. **User clicks “Fetch Mails”**  
   - `POST /api/fetch-emails` starts **Phase 1** in the background and returns a `job_id`.  
   - Frontend opens `GET /api/events/{job_id}` (SSE) for live attachment status.

2. **Phase 1 (LangGraph)** — `workflow.py`  
   - **Ingestion** — IMAP: find **all** matching parent emails not yet in the DB (newest first) and save them immediately, then run extraction on each. **`MAX_ATTACHMENTS`** in `.env` caps how many parts are stored when set to a positive integer; **`0`** keeps **all** parts.  
   - **Extraction** — For each attachment, call NVIDIA LLM → JSON vessel list → upsert into DB. A **vertical tonnage parser** (`vertical_tonnage.py`) handles broker layouts that use stacked PORT OPEN / DWT blocks; regex fallback runs when the LLM returns zero rows.  
   - **Signature pass** — For each attachment body tail: NVIDIA LLM extracts broker **emails** / **phones**, merged with a **regex fallback**. Values are stored on **`attachments`** (`signature_emails`, `signature_phones`).  
   - **Normalization** — Maps raw LLM keys into the **standard 22-field schema** stored in `vessels.dynamic_data`.

3. **Email Data tab**  
   - Lists parent emails and attachments with extraction status.  
   - **Preview** loads raw text + vessels per attachment.  
   - **Retry extraction** for attachments that failed or returned zero vessels when a vertical layout is detected.

4. **Vessel Position List tab**  
   - `GET /api/vessels` loads **all vessels** from every validation-ready parent email in the DB (not just the latest fetch).  
   - `GET /api/columns` returns the **25-column grid schema** from PostgreSQL `column_definitions` (22 dynamic keys + SR. NO, REGION, ATTACHMENTS).  
   - Double-click cells to edit; changes `PUT /api/vessels/{id}`. Delete key removes selected rows.  
   - **Checkboxes** — draft can use **selected rows only**; if none selected, **all rows** are sent.  
   - **Generate Draft** runs Phase 2. On success a **Map & Draft modal** opens automatically (zone map, legend, read-only grid, **Copy to Clipboard**). A green **View Map & Draft** button reopens the modal; it hides while a new draft is generating.

5. **Draft generation**  
   - `POST /api/generate-draft` with `{ email_id, vessels, grid_columns }` starts **Phase 2**, returns `job_id`.  
   - SSE delivers `drafting_done` with `draft_html` + `zones` (lat/lng/count per broad zone).  
   - **Drafter** groups rows by mapped zone (e.g. STRAITS/SEA, FAR EAST), builds **HTML tables with the same columns as the grid**. A short **intro paragraph** is generated via LLM.

6. **Contact List tab**  
   - `GET /api/contacts` — one row per attachment: date received, subject, sender, filename, broker emails, broker phones.  
   - Double-click **Broker emails** or **Broker phones** to edit; saves via `PUT /api/attachments/{id}/contacts`.

---

## Tech stack

| Layer | Technology |
|--------|------------|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Orchestration | LangGraph (Phase 1 + Phase 2) |
| LLM | NVIDIA NIM (configurable, e.g. `nvidia/nemotron-3-super-120b-a12b`) |
| Database | PostgreSQL (local or RDS; accessed via `pg_db.py` Supabase-style API) |
| Real-time | SSE (`sse-starlette`), `useSSE.js` |
| Frontend | React 18, Vite, TailwindCSS |
| Grid | TanStack Table v8 |
| Map | Leaflet / react-leaflet |

---

## Repository layout

```
├── schema.sql                 # DDL — run once on your PostgreSQL database
├── .gitignore
├── README.md
├── docs/aws-deployment/       # ECS / RDS / S3 / CloudFront runbook
├── backend/
│   ├── .env.example           # Template — copy to .env
│   ├── Dockerfile
│   ├── main.py                # FastAPI routes, SSE, CORS
│   ├── config.py              # Pydantic Settings → env vars
│   ├── database.py            # DB singleton (alias `supabase` for agents)
│   ├── pg_db.py               # PostgreSQL query builder (Supabase-like)
│   ├── column_defs.py         # Standard 22 keys, column_definitions seed, migration
│   ├── models.py              # Request/response models
│   ├── imap_client.py         # Gmail IMAP + .eml parsing
│   ├── sse_manager.py         # In-memory SSE fan-out per job_id
│   ├── workflow.py            # LangGraph graphs
│   └── agents/
│       ├── ingestion.py
│       ├── extraction.py
│       ├── vertical_tonnage.py   # Vertical PORT OPEN / DWT block parser
│       ├── normalization.py
│       ├── signature_extract.py  # LLM + regex fallback → attachments.signature_*
│       └── drafter.py            # Zone grouping + grid-aligned HTML + intro LLM
└── frontend/
    ├── vite.config.js         # Dev server + proxy /api → :8000, allowedHosts for ngrok
    ├── package.json
    └── src/
        ├── App.jsx            # Top nav + tab routing
        ├── services/api.js    # All REST calls under /api
        ├── hooks/useSSE.js
        └── components/
            ├── InboxView/         # Email Data
            ├── ValidationView/    # Vessel Position List + DraftModal
            ├── ContactListView/   # Broker contacts table
            └── DraftView/         # Map + grid content (used inside modal)
```

---

## AWS deployment (step-by-step)

Full runbook: **[docs/aws-deployment/README.md](docs/aws-deployment/README.md)** (Phases 0–7, troubleshooting, prod cutover).

**Dev environment (live):** https://d2bt5vx8sl8jq9.cloudfront.net — ECS + RDS + S3 + CloudFront in `ap-southeast-1` (`emailparsing-dev`).

---

## Prerequisites

- **Python 3.11+**
- **Node.js 18+** (for Vite)
- **PostgreSQL** (e.g. local via pgAdmin) — database created and `schema.sql` applied
- **Gmail** account with an **App Password** for IMAP
- **NVIDIA NIM** API key ([NVIDIA API](https://integrate.api.nvidia.com))

---

## One-time setup

### 1. Database

Create a database (e.g. `email_parser`), then run the full **`schema.sql`** in pgAdmin or `psql`.  
On backend startup, `column_defs.py` seeds `column_definitions` and migrates existing vessel rows to the standard schema.

### 2. Backend

```powershell
cd backend
copy .env.example .env
# Edit .env: EMAIL_*, FILTER_SENDER, TARGET_SUBJECT, NVIDIA_*, PG_*
```

```powershell
# From repo root — create venv if needed
python -m venv venv
.\venv\Scripts\Activate.ps1
cd backend
pip install -r requirements.txt
```

### 3. Frontend

```powershell
cd frontend
npm install
```

---

## Run locally

**Terminal 1 — API**

```powershell
cd backend
..\venv\Scripts\Activate.ps1
uvicorn main:app --reload --port 8000
```

- API: `http://localhost:8000`  
- Docs: `http://localhost:8000/docs`

**Terminal 2 — UI**

```powershell
cd frontend
npm run dev
```

- App: `http://localhost:5173`

---

## Optional: share via ngrok

Tunnel the **Vite** port so `/api` is still proxied on your machine:

```text
ngrok http 5173
```

Ensure `frontend/vite.config.js` allows your ngrok host (`allowedHosts`). Keep **backend + frontend + ngrok** running.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `EMAIL_USER` | Gmail address |
| `EMAIL_PASSWORD` | Gmail **App Password** |
| `IMAP_SERVER` / `IMAP_PORT` | Default `imap.gmail.com` / `993` |
| `FILTER_SENDER` | Only process emails from this sender |
| `TARGET_SUBJECT` | Subject substring filter |
| `NVIDIA_API_KEY` | NVIDIA NIM key |
| `NVIDIA_LLM_MODEL` | Chat model for vessel extraction, signature extraction, and draft intro |
| `NVIDIA_API_BASE_URL` | Default NVIDIA integrate endpoint |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | PostgreSQL connection |
| `MAX_ATTACHMENTS` | **`0`** = process **all** `.eml` parts; set **`N > 0`** to cap at the first N parts |

---

## API summary (prefix `/api`)

| Method | Path | Role |
|--------|------|------|
| GET | `/health` | Health check |
| POST | `/fetch-emails` | Start Phase 1 → `job_id` |
| POST | `/emails/{id}/retry-extraction` | Retry failed / zero-vessel attachments |
| GET | `/events/{job_id}` | SSE stream |
| GET | `/emails` | List parent emails + attachment summaries |
| GET | `/emails/{id}/attachments` | Attachments for one email |
| GET | `/attachments/{id}/raw` | Raw text + signature fields for preview |
| GET | `/attachments/{id}/vessels` | Vessels for one attachment |
| GET | `/vessels` | All vessels across validation-ready emails (Position List grid) |
| GET | `/emails/{id}/vessels` | Vessels for one parent email |
| GET | `/columns` | Column definitions from PostgreSQL |
| GET | `/emails/{id}/columns` | Same column list (legacy path) |
| GET | `/contacts` | All attachments with parent context + broker contacts |
| PUT | `/attachments/{id}/contacts` | Update `signature_emails` / `signature_phones` |
| PUT | `/vessels/{id}` | Update vessel row |
| DELETE | `/vessels/{id}` | Delete vessel row |
| POST | `/emails/{id}/vessels` | Add blank row |
| POST | `/generate-draft` | Phase 2 → `job_id`, then SSE `drafting_done` |

---

## Gmail App Password

1. Google Account → Security → **2-Step Verification** on.  
2. **App passwords** → create for Mail.  
3. Use the 16-character value as `EMAIL_PASSWORD` (no spaces).

---

## License / usage

Demo-oriented local stack; do not commit `.env` or real credentials. This repo uses **MIT-friendly** frontend dependencies (e.g. TanStack Table, Leaflet).

---

## Push to `dev_testing`

From the repo root:

```powershell
cd D:\Asset_Modules\Email_Parser_Two
git status
git add .
git commit -m "feat: contact list, draft modal, standard columns, vertical parser"
git push origin dev_testing
```
