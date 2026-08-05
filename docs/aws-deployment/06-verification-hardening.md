# Phase 6 — Verification, hardening, production cutover

**Goal:** Confirm full Shipbroker Sense pipeline on AWS; document gaps before **prod**.

**Status:** 🔄 Dev E2E verified (Fetch, Validate, Draft, library enrichment, Morning Brief on CloudFront); prod hardening open.

---

## Dev verification (completed)

| # | Action | Result |
|---|--------|--------|
| 1 | https://d2bt5vx8sl8jq9.cloudfront.net | UI loads (Shipbroker Sense) |
| 2 | Validate grid | Vessels from RDS |
| 3 | Generate Draft | Works after WAF monitor mode + `/api/*` behavior fix |
| 4 | ALB `/api/health` direct | `db: ok` |
| 5 | Home `/api/home/summary` | Today-scoped Morning Brief |
| 6 | Vessel library enrichment | After Phase-1; yellow cells from Claude web_search |

---

## Checklist — before calling prod “ready”

### Application
- [x] E2E on CloudFront URL (dev)
- [ ] E2E after each release (runbook below)
- [ ] Long **Fetch** job (many attachments) — ALB idle timeout 300–600 s
- [ ] Confirm enrichment after Fetch (Library tab spinner + yellow cells)

### Security
- [ ] Remove pgAdmin **My IP** from `email-parser-rds-sg`
- [ ] RDS **public access = No** (prod)
- [ ] WAF: tuned rules (not only monitor mode)
- [ ] Secrets rotation plan (Gmail, Anthropic, RDS)
- [ ] No secrets in git / Docker image
- [ ] Auth or IP allowlist before public launch
- [ ] Attachments bucket + task role verified ([08-attachments-s3.md](./08-attachments-s3.md))
- [ ] Anthropic account allows **web_search** (enrichment cost / quota)

### CloudFront / API
- [ ] Re-add **404 → index.html (200)** only (not 403)
- [ ] Confirm `/api/*`: ALB origin, **CachingDisabled**, **POST** allowed
- [ ] Delete unused ECS service `email-parser-service`

### CORS
- [x] Not required while UI + API share one CloudFront domain
- [ ] If using separate `app.` / `api.` domains — add origins:

```python
# backend/main.py — example when split domains
allow_origins=[
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://<cloudfront-domain>.cloudfront.net",
    "https://app.yourdomain.com",
]
```

**Recommended for prod:** `CORS_ORIGINS` env var in Secrets Manager.

---

## Troubleshooting reference

### ECS

| Symptom | Fix |
|---------|-----|
| Task stops, `AccessDenied` secret | IAM `emaildev-*` on **execution** role |
| Task stops, `ResourceNotFound` | Fix secret ARN suffix in task def |
| Task stops, RDS **connection timed out** | `email-parser-rds-sg`: allow **5432** from **`email-parser-ecs-sg`** |
| Task stops, `proxies` TypeError | Rebuild with `httpx==0.27.2` + `anthropic==0.49.0` |
| 0/1 running | CloudWatch logs; stopped reason |
| Old emails after DB cutover | Confirm secret `PG_DATABASE=email_parser` + force new deployment |
| S3 AccessDenied on attachments | Set **task role** `ecsTaskRole-email-parser` (not only execution role) |
| Enrichment errors / no yellow cells | Confirm image includes `vessel_enrichment.py`; Anthropic web_search enabled |

### CloudFront / UI

| Symptom | Fix |
|---------|-----|
| `/` Access Denied XML | S3 OAC bucket policy |
| Blank UI, 404 on assets | Upload `assets/` under `assets/` prefix |
| `/api/health` **504**, ALB OK | `email-parser-alb-sg`: 80/443 from `0.0.0.0/0` |
| `/api/home/summary` **404** flicker | Old API image — push latest + force deploy |
| Draft: `Unexpected token '<'` | API returned HTML — error pages or POST to S3 |
| Draft: HTTP 403 | WAF monitor mode or allow POST |
| `generate-draft` Server AmazonS3 | `/api/*` not ALB; allow POST; CachingDisabled |
| Old UI after deploy | Wait for invalidation; hard-refresh (`Ctrl+Shift+R`) |

### ALB DNS

Copy from **EC2 → Load balancers**. Dev suffix: **`656767385`**.

---

## End-to-end test script

| # | Action | Expected |
|---|--------|----------|
| 1 | Open CloudFront URL | Shipbroker Sense UI |
| 2 | Home | Morning Brief for **today** |
| 3 | Fetch Mails | `job_id`; SSE in Inbox; sync done at **`phase1_complete`** |
| 4 | Vessel Libraries List | Enrichment spinner (separate); light yellow cells fill blanks |
| 5 | Validate | Grid + signatures |
| 6 | Edit cell | PUT saves |
| 7 | Generate Draft | `job_id`; Draft tab + map |
| 8 | Copy draft | Clipboard |

---

## CloudWatch

Log group: **`/ecs/email-parser-api`**

Filter: `ERROR`, `Phase1`, `Phase2`, `phase1_complete`, `Enrich`, `web_search`, `AutoFetch`, `PostgreSQL`, `IMAP`

---

## Release runbook

Deploy from **`aws-deployment`** only.

```text
1. backend/
   docker build -t email-parser-api:local .
   docker tag ... email-parser-api:latest
   docker push 867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest

2. ECS → Force new deployment (task def currently email-parser-api:6)
   --force-new-deployment pulls new :latest image

3. frontend/
   npm run build
   aws s3 sync dist/ s3://email-parser-ui-867492128821/ --delete

4. CloudFront → Invalidation → /*

5. Smoke:
   https://d2bt5vx8sl8jq9.cloudfront.net/api/health
   Home Morning Brief
   Fetch → inbox done → Library enrichment spinner / yellow cells
   Optional: Generate Draft (few rows)
```

---

## Production cutover checklist

Use **new** resources in `emailparsing-prod` — do not copy dev secrets.

```text
[ ] New Secrets Manager secret (prod name)
[ ] New RDS (private, backups on)
[ ] New ECR tags (:v1.0.0 not only :latest)
[ ] New ECS cluster / service
[ ] New S3 UI bucket + attachments bucket + CloudFront distribution
[ ] ACM certificate (us-east-1) + custom domain
[ ] WAF reviewed with security team
[ ] Remove all dev temporary SG rules
[ ] AWS Budgets / alarms
[ ] Document on-call / rollback (previous task definition revision)
[ ] Confirm Anthropic web_search enabled for library enrichment
```

---

## Phase 6 complete when

- [x] Team can use **dev** CloudFront URL for real work
- [ ] Prod checklist signed off with manager

**Optional:** [07-future-improvements.md](./07-future-improvements.md)
