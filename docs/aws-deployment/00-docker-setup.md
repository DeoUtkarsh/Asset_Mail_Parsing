# Phase 0 — Install Docker on Windows

**Goal:** Run containers on your laptop so the FastAPI backend can be packaged the same way AWS (ECS) will run it.

**Status:** ✅ Done

**Time:** ~30–60 minutes (includes WSL 2 if not already installed).

---

## What you need

- Windows 10/11 **64-bit** (Home or Pro)
- **Virtualization enabled** in BIOS/UEFI (often called Intel VT-x / AMD-V)
- Admin rights on the PC
- ~4 GB free disk for Docker Desktop

---

## Step 0.1 — Check virtualization

1. Open **Task Manager** → **Performance** → **CPU**.
2. Confirm **Virtualization: Enabled**.

If it says **Disabled**, reboot into BIOS/UEFI and enable virtualization, then boot back into Windows.

---

## Step 0.2 — Install WSL 2 (required by Docker Desktop)

Open **PowerShell as Administrator** and run:

```powershell
wsl --install
```

If WSL is already installed, ensure version 2 is default:

```powershell
wsl --set-default-version 2
wsl --update
```

**Reboot** if the installer asks you to.

After reboot, verify:

```powershell
wsl --status
wsl -l -v
```

You should see a Linux distro (e.g. `Ubuntu`) with **VERSION 2**.

> **Optional:** If `wsl --install` fails, install manually:  
> [Microsoft WSL install guide](https://learn.microsoft.com/en-us/windows/wsl/install)

---

## Step 0.3 — Install Docker Desktop

1. Download **Docker Desktop for Windows**:  
   https://www.docker.com/products/docker-desktop/
2. Run the installer.
3. When asked, use **WSL 2** as the backend (recommended).
4. Finish install and **start Docker Desktop**.
5. Wait until the whale icon in the system tray shows **Docker Desktop is running**.

First launch may take a few minutes.

---

## Step 0.4 — Verify Docker works

Open a **normal** PowerShell (not necessarily admin):

```powershell
docker version
docker compose version
```

Both should print **Client** and **Server** sections without errors.

Run the hello-world test:

```powershell
docker run hello-world
```

You should see a message like **"Hello from Docker!"**.

- [ ] `docker version` works
- [ ] `docker run hello-world` works

---

## Step 0.5 — Common fixes (Windows)

| Problem | What to try |
|---------|-------------|
| "Docker Desktop failed to start" | Restart PC; open Docker Desktop → Settings → ensure WSL integration is on for your distro |
| WSL 2 not detected | `wsl --update` then reboot |
| Hyper-V / virtualization errors | Enable virtualization in BIOS; on Pro, ensure Hyper-V / Virtual Machine Platform features are on |
| Corporate proxy | Docker Desktop → Settings → Resources → Proxies |
| Slow first pull | Normal; images download from the internet |

---

## Step 0.6 — (After Phase 1 files exist) Build this project’s API image

**Do this in Phase 1**, not before the `Dockerfile` exists in the repo.

Build context is **`backend/`** (recommended) so `requirements.txt` installs
`anthropic==0.49.0`, `httpx==0.27.2`, and `tzdata==2025.2` (Claude + web_search enrichment
and Home calendar day zones).

From `backend/`:

```powershell
cd D:\Asset_Modules\Email_Parser_Two\backend
docker build -t email-parser-api:local .
docker run --rm -p 8000:8000 --env-file .env -e PG_HOST=host.docker.internal email-parser-api:local
```

In another terminal:

```powershell
curl http://localhost:8000/api/health
```

Expect JSON with `"status":"ok"` and `"db":"ok"` when Postgres is running locally.

- [ ] API image builds (Phase 1)
- [ ] Container serves `/api/health` (Phase 1)

---

## Phase 0 complete when

- [ ] Docker Desktop runs reliably after reboot
- [ ] `docker run hello-world` succeeds
- [ ] You understand: **image** = packaged app, **container** = running instance

**Next:** [01-container-ecr-secrets.md](./01-container-ecr-secrets.md) — we will add `Dockerfile`, build, and push to ECR together.
