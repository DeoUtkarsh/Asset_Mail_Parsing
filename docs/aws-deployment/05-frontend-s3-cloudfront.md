# Phase 5 — React build, S3, CloudFront (Shipbroker Sense UI)

**Goal:** **Shipbroker Sense** UI on **S3 + CloudFront**; **`/api/*`** → ALB (same-origin `/api` as local Vite proxy).

**Status:** ✅ Done (dev)

---

## Dev values

| Item | Value |
|------|--------|
| S3 bucket | `email-parser-ui-867492128821` |
| S3 origin domain | `email-parser-ui-867492128821.s3.ap-southeast-1.amazonaws.com` |
| CloudFront ID | `E2Q4F6X2F4IA27` |
| CloudFront name | `email-parser-ui` |
| Public URL | **https://d2bt5vx8sl8jq9.cloudfront.net** |
| ALB origin | `email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com` (HTTP **80**) |
| WAF | Core protections **enabled**, **monitor mode ON** (dev) |

---

## Checklist

- [x] `npm run build` → `frontend/dist/`
- [x] S3: `index.html` + `assets/*.js` + `assets/*.css` at bucket root
- [x] S3 bucket policy (OAC) applied
- [x] CloudFront default root object: `index.html`
- [x] Behavior `/api/*` → ALB, **CachingDisabled**, POST allowed
- [x] Behavior `Default (*)` → S3
- [x] WAF monitor mode (POST was 403 when blocking)
- [ ] SPA error page: **404 → index.html (200)** only (see below)
- [ ] Custom domain + ACM (prod)

---

## Step 5.1 — Build

```powershell
cd D:\Asset_Modules\Email_Parser_Two\frontend
npm install
npm run build
```

Output: `frontend/dist/` — Vite references `/assets/index-*.js` and `.css`.

---

## Step 5.2 — S3 upload

**Bucket:** `email-parser-ui-867492128821` · **Block public access: ON**

Required object layout:

```text
index.html
assets/index-<hash>.js
assets/index-<hash>.css
```

**Console:** upload `index.html` to **bucket root**; create folder **`assets/`** and upload both files inside it.

**CLI:**

```powershell
aws s3 sync frontend/dist/ s3://email-parser-ui-867492128821/ --delete --profile emailparser-dev
```

---

## Step 5.3 — CloudFront distribution

### Origins

| Origin | Domain | Protocol |
|--------|--------|----------|
| S3 | `email-parser-ui-867492128821.s3.ap-southeast-1.amazonaws.com` | OAC |
| ALB | `email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com` | **HTTP only**, port **80** |

**S3 origin field:** use full `*.s3.ap-southeast-1.amazonaws.com` hostname — not bucket name alone. **Origin path:** empty.

After create: apply **S3 bucket policy** from CloudFront banner (OAC).

### Behaviors (critical)

| Precedence | Path | Origin | Cache policy | HTTP methods |
|------------|------|--------|--------------|--------------|
| 0 | `/api/*` | **ALB** | **CachingDisabled** | GET, HEAD, OPTIONS, PUT, **POST**, PATCH, DELETE |
| Default | `*` | **S3** | CachingOptimized | GET, HEAD |

**Origin request policy (API):** **AllViewer**

**Do not** create a second ALB or target group if one already exists from Phase 4.

### General settings

- **Default root object:** `index.html`
- **Viewer protocol:** Redirect HTTP to HTTPS

### Custom error responses (SPA)

| Use | HTTP error | Response | HTTP code |
|-----|------------|----------|-----------|
| **OK** | 404 | `/index.html` | **200** |
| **Avoid** | **403** | `/index.html` | 200 |

**Why:** Distribution-wide error pages also apply to **`/api/*`**. A **403** on API (e.g. WAF) becomes HTML `index.html` → frontend error *"Unexpected token '<'"*.

During debugging, dev **removed** both 403 and 404 custom errors. For prod, re-add **404 only**.

### WAF (Security tab)

Dev: **AWS WAF protection enabled** + **Use monitor mode** checked.

| Mode | Effect |
|------|--------|
| Block (monitor off) | Large `POST /api/generate-draft` often **403** |
| Monitor mode | Logs only; API POST works |

For prod: work with security team to tune rules or exclude `/api/*` POST bodies.

---

## Step 5.4 — Invalidate after changes

**CloudFront** → **Invalidations** → path: `/*`

---

## Step 5.5 — Verify

```text
https://d2bt5vx8sl8jq9.cloudfront.net/
https://d2bt5vx8sl8jq9.cloudfront.net/api/health
```

Product checks (hard-refresh after invalidation):

| Check | Expected |
|-------|----------|
| Branding | **Shipbroker Sense** (title / login / top bar) |
| Home | Morning Brief for **today**; review / positions-ready cards |
| Fetch Emails | Inbox sync completes at Phase-1; toast when done |
| Vessel Libraries List | Separate enrichment spinner **after** Phase-1; light yellow cells = web enrichment |
| Generate Draft | Network: 200 JSON from uvicorn (not S3 HTML) |

**Generate Draft** — Network tab on `generate-draft`:

| Good | Bad |
|------|-----|
| 200, `application/json`, Server `uvicorn` | 403, or `text/html`, or `Server: AmazonS3` |

---

## CORS note

UI and API share **`d2bt5vx8sl8jq9.cloudfront.net`** → **same origin**. No CORS change required for current setup.

If you split UI and API to different domains later, update `backend/main.py` or `CORS_ORIGINS` env — see [06-verification-hardening.md](./06-verification-hardening.md).

---

## SSE (`GET /api/events/{jobId}`)

Long-lived SSE through CloudFront usually works for dev. If Fetch progress stalls:

1. Test ALB URL directly for SSE.
2. Consider `api.<domain>` → ALB only (see Phase 7).

---

## Phase 5 complete when

- [x] UI loads on CloudFront HTTPS
- [x] `/api/health` OK on same host
- [x] Generate Draft returns `job_id`

**Next:** [06-verification-hardening.md](./06-verification-hardening.md)
