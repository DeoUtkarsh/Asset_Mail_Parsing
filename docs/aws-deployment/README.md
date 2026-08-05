# AWS deployment — Shipbroker Sense (Email Parser)

Track progress and **production handoff** here. Work **one phase at a time** for a fresh
deploy; use **[Deployed resources](#deployed-resources-dev)** and **[Troubleshooting](#troubleshooting)** when debugging.

**App:** FastAPI (port 8000) + React/Vite (static) + PostgreSQL (RDS) + Gmail IMAP +
**Anthropic Claude** + attachment files on **S3** + in-memory SSE → **1 ECS task**.

---

## Progress overview

| Phase | Document | Status (dev) |
|-------|----------|----------------|
| 0 | [00-docker-setup.md](./00-docker-setup.md) | ✅ Done |
| 1 | [01-container-ecr-secrets.md](./01-container-ecr-secrets.md) | ✅ Done |
| 2 | [02-network-vpc.md](./02-network-vpc.md) | ✅ Done |
| 3 | [03-database-rds.md](./03-database-rds.md) | ✅ Done |
| 4 | [04-backend-ecs-alb.md](./04-backend-ecs-alb.md) | ✅ Done |
| 5 | [05-frontend-s3-cloudfront.md](./05-frontend-s3-cloudfront.md) | ✅ Done |
| 6 | [06-verification-hardening.md](./06-verification-hardening.md) | 🔄 Dev verified; prod hardening pending |
| 7 | [07-future-improvements.md](./07-future-improvements.md) | ⬜ Optional / later |
| 8 | [08-attachments-s3.md](./08-attachments-s3.md) | ✅ Done (bucket `email-parser-mail`) |

---

## Live URLs (dev — `emailparsing-dev`)

| Purpose | URL |
|---------|-----|
| **App (use this)** | https://d2bt5vx8sl8jq9.cloudfront.net |
| API health | https://d2bt5vx8sl8jq9.cloudfront.net/api/health |
| API docs | https://d2bt5vx8sl8jq9.cloudfront.net/docs |
| ALB direct (debug) | http://email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com |

> **ALB DNS suffix is `656767385`**. Copy from **EC2 → Load balancers** if unsure.

---

## Deployed resources (dev)

| Resource | Dev value |
|----------|-----------|
| AWS account | `867492128821` (`emailparsing-dev`) |
| Region | `ap-southeast-1` (Singapore) |
| CLI profile | `emailparser-dev` |
| SSO | https://d-9667a822b5.awsapps.com/start — prefer **InfraAdmin** for infra |
| VPC | Default `vpc-03daed954804ba2d9` |
| ECR image | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Secrets Manager | **`emaildev`** (ARN suffix `4sFMnJ` — verify in console) |
| RDS instance | `email-parser-db` |
| **Active app DB** | **`email_parser`** (underscore) |
| Legacy DB (unused by app) | `email_parser_import` (kept as backup) |
| RDS endpoint | `email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com` |
| ECS cluster | `email-parser-cluster` |
| ECS service | `email-parser-api-service-khf6bfgk` |
| Task definition | `email-parser-api` — use **latest** revision (e.g. `:5+`) |
| Task **execution** role | `ecsTaskExecutionRole-email-parser` (ECR + secrets + logs) |
| Task **role** (runtime) | `ecsTaskRole-email-parser` (S3 Get/Put on attachments bucket) |
| CloudWatch logs | `/ecs/email-parser-api` |
| ALB / TG | `email-parser-alb` / `email-parser-tg` (IP, **8000**, `/api/health`) |
| Security groups | `email-parser-alb-sg`, `email-parser-ecs-sg`, `email-parser-rds-sg` |
| UI S3 bucket | `email-parser-ui-867492128821` |
| **Attachments S3** | **`email-parser-mail`** (prefix `attachment_files/`) |
| CloudFront | `E2Q4F6X2F4IA27` → `d2bt5vx8sl8jq9.cloudfront.net` |

---

## Current architecture (dev)

```text
Browser
  → CloudFront (HTTPS)
       ├─ /*          → S3 UI bucket
       └─ /api/*      → ALB :80 → ECS Fargate (1 task) :8000
                            ├─ Secrets Manager (emaildev)
                            ├─ RDS Postgres (email_parser)
                            └─ S3 email-parser-mail (attachment files)
                            └─ IMAP (Gmail) + Anthropic API (outbound)
```

---

## Master checklist (high level)

### Phase 0–5 — Core platform
- [x] Docker image builds; ECR push
- [x] Secret **`emaildev`** with Anthropic + PG_* + S3 keys (see Phase 1)
- [x] Execution role + **task role** for S3
- [x] VPC SGs: ALB `0.0.0.0/0` on 80/443; RDS allows **`email-parser-ecs-sg`** on 5432
- [x] RDS + database **`email_parser`** (tables auto-created on ECS startup)
- [x] ECS Fargate desired **1**, public IP **on**
- [x] CloudFront UI + `/api/*` → ALB

### Phase 6 — Hardening
- [x] E2E Fetch / Validate / Draft on CloudFront (dev)
- [ ] Remove temporary RDS “My IP” when not using pgAdmin
- [ ] WAF tuned for prod POSTs
- [ ] Auth before wide public use

### Phase 8 — Attachments
- [x] Bucket `email-parser-mail`; task role S3 policy; env keys in secret + task def

---

## Recommended order (new environment)

```text
00 Docker → 01 ECR + secrets → 02 VPC/SG → 03 RDS → 04 ECS/ALB
→ 05 CloudFront → 08 Attachments S3 → 06 harden
```

---

## Decisions (dev)

| Item | Choice |
|------|--------|
| LLM | Anthropic Claude (`ANTHROPIC_API_KEY`, `CLAUDE_MODEL`) |
| App DB name | `email_parser` (**underscore**, not hyphen) |
| Attachment storage | S3 `email-parser-mail` / `attachment_files/` |
| Local attachment storage | `backend/attachment_files/` when bucket unset |
| Fetch cap | `MAX_ATTACHMENTS=0` (all **new** Message-IDs) |
| SSE | In-memory → **desired count = 1** |

---

## Local vs AWS

| | Local | AWS (dev) |
|--|-------|-----------|
| UI | Vite `:5173` | CloudFront → S3 |
| API | `:8000` / proxy | CloudFront `/api/*` → ALB → ECS |
| DB | Laptop Postgres | RDS `email_parser` |
| Secrets | `backend/.env` | Secrets Manager `emaildev` |
| Attachment files | `attachment_files/` | S3 `email-parser-mail` |
| SSE | 1 process | **1 ECS task** |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| ECS: `AccessDenied` on secret | Execution role | `GetSecretValue` on `emaildev-*` |
| ECS: `ResourceNotFound` secret | Wrong ARN suffix | Copy exact suffix from Secrets console |
| ECS: `connection timed out` to RDS | RDS SG | Inbound **5432** from **`email-parser-ecs-sg`** (not only My IP) |
| ECS: `unexpected keyword argument 'proxies'` | httpx vs anthropic | Image must pin `httpx==0.27.2` (see `requirements.txt`) |
| CloudFront `/api/health` **504**, ALB OK | ALB SG locked to My IP | `email-parser-alb-sg`: **80/443** from `0.0.0.0/0` |
| UI shows old emails after DB cutover | Task still on old secret / old DB | Force new deployment; confirm logs `PG_DATABASE=email_parser` |
| Empty `email_parser` (0 tables) | App never started on that DB | Fix SG / crash, redeploy; startup creates tables |
| `/api/home/summary` **404** flicker | Old image without route | Push latest image + force deploy |
| Draft **403** | WAF | Monitor mode or allow POST |

---

## Release runbook (each deploy)

```text
1. backend/: docker build → tag → push ECR :latest
2. If secrets/env keys changed: new task definition revision
3. ECS: update service → Force new deployment (latest task def)
4. frontend/: npm run build → aws s3 sync dist/ → CloudFront invalidation /*
5. Smoke: /api/health → CloudWatch startup (DB + FILE STORAGE + AUTO_FETCH_IDLE : ON) → Fetch Emails
```

### Auto-fetch (IMAP IDLE)

On the **`aws-deployment`** branch / ECS secret set:

```text
AUTO_FETCH_IMAP_IDLE=true
```

ECS keeps one IMAP IDLE on the broker INBOX. On startup it records the current highest
IMAP UID and **ignores mail already in INBOX**. Only messages that arrive *after* that
baseline are auto-ingested (plus Message-ID dedupe). Historical backfill is **manual
Fetch Emails + date range** only.

On `feature/frontend-redesign`, local default is `AUTO_FETCH_IMAP_IDLE=true` so you can
test live inbox progress. Set it to `false` in `.env` if you only want manual Fetch.
Optional local AWS env file: `backend/.env.aws` (gitignored) + `ENV_FILE=.env.aws`.

### CMD example (Windows)

```cmd
cd /d D:\Asset_Modules\Email_Parser_Two\backend
aws sso login --profile emailparser-dev
docker build -t email-parser-api:local .
aws ecr get-login-password --region ap-southeast-1 --profile emailparser-dev | docker login --username AWS --password-stdin 867492128821.dkr.ecr.ap-southeast-1.amazonaws.com
docker tag email-parser-api:local 867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest
docker push 867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest
aws ecs update-service --cluster email-parser-cluster --service email-parser-api-service-khf6bfgk --task-definition email-parser-api:5 --force-new-deployment --region ap-southeast-1 --profile emailparser-dev

cd /d D:\Asset_Modules\Email_Parser_Two\frontend
npm run build
aws s3 sync dist/ s3://email-parser-ui-867492128821/ --delete --profile emailparser-dev
aws cloudfront create-invalidation --distribution-id E2Q4F6X2F4IA27 --paths "/*" --profile emailparser-dev
```

Bump `:5` to the current task definition revision after you create a new one.

---

## Moving to production

1. Repeat in **`emailparsing-prod`** with **new** secret, RDS, buckets, cluster (do not copy `emaildev`).
2. Private RDS; no laptop IP on `rds-sg`.
3. WAF + custom domain + ACM (`us-east-1` for CloudFront).
4. See [07-future-improvements.md](./07-future-improvements.md).

---

## Getting help

Say **“Phase 4 stuck”** or **“Prod cutover”** — keep this folder as source of truth.
