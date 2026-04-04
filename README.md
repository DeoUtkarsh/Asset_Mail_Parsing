# AI-Powered Shipbroking Email Parser

An agentic system that fetches `.eml` attachments from Gmail, extracts vessel position data using NVIDIA NIM, presents it in an editable validation grid, and generates a polished position-list email draft — all locally on your machine.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Agentic Framework | LangGraph |
| LLM | NVIDIA NIM (`nemotron-3-super-120b-a12b`) |
| Database | Supabase (PostgreSQL, free tier) |
| Real-time | Server-Sent Events (SSE via `sse-starlette`) |
| Frontend | React 18 + Vite + TailwindCSS |
| Data Grid | TanStack Table v8 (MIT, fully free) |

---

## One-Time Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret → `SUPABASE_SERVICE_KEY`
3. Open the **SQL Editor** in the Supabase dashboard and run the entire contents of `schema.sql` from this project.

### 2. Backend

```powershell
# From the project root (Email_Parser_Two\)
cd backend

# Copy the example env file and fill in your credentials
copy .env.example .env
# Edit .env: add your SUPABASE_URL, SUPABASE_SERVICE_KEY

# Activate the existing venv (or create one)
..\venv\Scripts\Activate.ps1

# Install all dependencies
pip install -r requirements.txt
```

### 3. Frontend

```powershell
# From the project root
cd frontend

# Install Node dependencies
npm install
```

---

## Running the App

You need **two terminal windows** open simultaneously.

### Terminal 1 — Backend

```powershell
cd backend
..\venv\Scripts\Activate.ps1
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.
Interactive docs: `http://localhost:8000/docs`

### Terminal 2 — Frontend

```powershell
cd frontend
npm run dev
```

Open your browser at **`http://localhost:5173`**.

---

## Usage Flow

### Module 1 — Inbox (Fetch)
1. Click **"⬇ Fetch Mails"**.
2. The backend connects to Gmail via IMAP, downloads all `.eml` attachments, and immediately starts extraction via the NVIDIA LLM (all 30 files **in parallel**).
3. You will see live status badges next to each file: `pending → extracting → done`.
4. Once all files are done, click **"Validate →"** next to the email.
5. Optionally click **"Preview"** on any file to see the raw text on the left and extracted vessels on the right.

### Module 2 — Validation Grid
- All vessels from all attachments appear in one Excel-like grid.
- **Double-click** any cell to edit it inline. Press `Enter` or click away to save.
- **✕** on the right deletes a row.
- Every edit is instantly persisted to Supabase.
- When satisfied, click **"✔ Approve & Generate Draft"**.

### Module 3 — Draft
- The AI-generated email appears in a read-only textarea.
- Click **"⎘ Copy to Clipboard"** and paste into Gmail/Outlook.

---

## Project Structure

```
Email_Parser_Two/
├── schema.sql                  ← Run this once in Supabase SQL Editor
├── backend/
│   ├── .env.example            ← Copy to .env and fill in secrets
│   ├── requirements.txt
│   ├── main.py                 ← FastAPI app + all routes
│   ├── config.py               ← Pydantic settings (reads .env)
│   ├── database.py             ← Supabase client singleton
│   ├── models.py               ← Pydantic request/response models
│   ├── imap_client.py          ← Gmail IMAP + .eml text extraction
│   ├── sse_manager.py          ← SSE event broadcaster
│   ├── workflow.py             ← LangGraph Phase 1 + Phase 2 graphs
│   └── agents/
│       ├── ingestion.py        ← Agent 1: fetch & save emails
│       ├── extraction.py       ← Agent 2: parallel NVIDIA LLM calls
│       ├── normalization.py    ← Agent 3: superset column builder
│       └── drafter.py         ← Agent 4: draft email generator
└── frontend/
    ├── package.json
    ├── vite.config.js          ← Proxy /api → localhost:8000
    ├── src/
    │   ├── App.jsx             ← 3-view SPA shell + nav
    │   ├── services/api.js     ← All fetch() calls to the backend
    │   ├── hooks/useSSE.js     ← EventSource hook
    │   └── components/
    │       ├── InboxView/      ← Module 1 (accordion + preview modal)
    │       ├── ValidationView/ ← Module 2 (TanStack Table editable grid)
    │       └── DraftView/      ← Module 3 (textarea + copy button)
```

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `EMAIL_USER` | Your Gmail address |
| `EMAIL_PASSWORD` | Gmail **App Password** (not your login password) |
| `IMAP_SERVER` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `FILTER_SENDER` | Only fetch emails from this address |
| `TARGET_SUBJECT` | Subject substring to match |
| `NVIDIA_API_KEY` | Your NVIDIA NIM API key |
| `NVIDIA_LLM_MODEL` | Model for extraction + drafting |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase `service_role` secret key |

---

## Gmail App Password

Standard Gmail passwords do not work with IMAP. You need a **16-character App Password**:

1. Go to [myaccount.google.com/security](https://myaccount.google.com/security).
2. Enable **2-Step Verification** if not already on.
3. Search for **"App Passwords"** and create one for "Mail".
4. Paste the 16-character code (no spaces) as `EMAIL_PASSWORD` in your `.env`.
