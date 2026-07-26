# Phase 6 — Verification, hardening, production cutover

**Goal:** Confirm full pipeline on AWS; document gaps before **prod**.

**Status:** 🔄 Dev E2E verified (Fetch, Validate, Draft on CloudFront); prod hardening open.

---

## Dev verification (completed)

| # | Action | Result |
|---|--------|--------|
| 1 | https://d2bt5vx8sl8jq9.cloudfront.net | UI loads |
| 2 | Validate grid | 140 vessels (RDS data) |
| 3 | Generate Draft | Works after WAF monitor mode + `/api/*` behavior fix |
| 4 | ALB `/api/health` direct | `db: ok` |

---

## Checklist — before calling prod “ready”

### Application
- [x] E2E on CloudFront URL (dev)
- [ ] E2E after each release (runbook below)
- [ ] Long **Fetch** job (many attachments) — ALB idle timeout 300–600 s

### Security
- [ ] Remove pgAdmin **My IP** from `email-parser-rds-sg`
- [ ] RDS **public access = No** (prod)
- [ ] WAF: tuned rules (not only monitor mode)
- [ ] Secrets rotation plan (Gmail, Anthropic, RDS)
- [ ] No secrets in git / Docker image
- [ ] Auth or IP allowlist before public launch
- [ ] Attachments bucket + task role verified ([08-attachments-s3.md](./08-attachments-s3.md))

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
| Task stops, `proxies` TypeError | Rebuild image with `httpx==0.27.2` |
| 0/1 running | CloudWatch logs; stopped reason |
| Old emails after DB cutover | Confirm secret `PG_DATABASE=email_parser` + force new deployment |
| S3 AccessDenied on attachments | Set **task role** `ecsTaskRole-email-parser` (not only execution role) |

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

### ALB DNS

Copy from **EC2 → Load balancers**. Dev suffix: **`656767385`**.

---

## End-to-end test script

| # | Action | Expected |
|---|--------|----------|
| 1 | Open CloudFront URL | React app |
| 2 | Fetch Mails | `job_id`; SSE in Inbox |
| 3 | Validate | Grid + signatures |
| 4 | Edit cell | PUT saves |
| 5 | Generate Draft | `job_id`; Draft tab + map |
| 6 | Copy draft | Clipboard |

---

## CloudWatch

Log group: **`/ecs/email-parser-api`**

Filter: `ERROR`, `Phase1`, `Phase2`, `PostgreSQL`, `IMAP`

---

## Release runbook

```text
1. backend/
   docker build -t email-parser-api:local .
   docker tag ... email-parser-api:latest
   docker push 867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest

2. ECS → task definition new revision (if env changed) OR Update service → Force new deployment

3. frontend/
   npm run build
   aws s3 sync dist/ s3://email-parser-ui-867492128821/ --delete

4. CloudFront → Invalidation → /*

5. Smoke:
   https://d2bt5vx8sl8jq9.cloudfront.net/api/health
   Optional: one Fetch + Generate Draft (5 rows)
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
```

---

## Phase 6 complete when

- [x] Team can use **dev** CloudFront URL for real work
- [ ] Prod checklist signed off with manager

**Optional:** [07-future-improvements.md](./07-future-improvements.md)
