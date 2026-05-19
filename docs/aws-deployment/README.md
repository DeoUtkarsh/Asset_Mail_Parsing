# AWS deployment — Email Parser

Track progress and **production handoff** here. Work **one phase at a time** for a fresh deploy; use the **[Deployed resources](#deployed-resources-dev)** and **[Troubleshooting](#troubleshooting)** sections when debugging.

**App:** FastAPI (port 8000) + React/Vite (static) + PostgreSQL + Gmail IMAP + NVIDIA NIM + in-memory SSE (→ **1 ECS task** until Redis/DB events).

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

---

## Live URLs (dev — `emailparsing-dev`)

| Purpose | URL |
|---------|-----|
| **App (use this)** | https://d2bt5vx8sl8jq9.cloudfront.net |
| API health | https://d2bt5vx8sl8jq9.cloudfront.net/api/health |
| API docs | https://d2bt5vx8sl8jq9.cloudfront.net/docs |
| ALB direct (debug) | http://email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com |

> **ALB DNS suffix is `656767385`** (not `656767585`). Copy from **EC2 → Load balancers** if unsure.

---

## Deployed resources (dev)

Fill in when cloning to **prod** (`emailparsing-prod` — read-only today).

| Resource | Dev value |
|----------|-----------|
| AWS account | `867492128821` (`emailparsing-dev`) |
| Region | `ap-southeast-1` (Singapore) |
| CLI profile | `emailparser-dev` |
| VPC | Default `vpc-03daed954804ba2d9` |
| ECR image | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Secrets Manager | **`emaildev`** (ARN suffix `4sFMnJ`) |
| RDS instance | `email-parser-db` |
| RDS database | **`email_parser_import`** |
| RDS endpoint | `email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com` |
| ECS cluster | `email-parser-cluster` |
| ECS service (active) | `email-parser-api-service-khf6bfgk` |
| Task definition | `email-parser-api:3` (use latest after changes) |
| Task execution role | `ecsTaskExecutionRole-email-parser` |
| CloudWatch logs | `/ecs/email-parser-api` |
| ALB | `email-parser-alb` |
| Target group | `email-parser-tg` (IP, port **8000**, health `/api/health`) |
| S3 UI bucket | `email-parser-ui-867492128821` |
| CloudFront distribution | `E2Q4F6X2F4IA27` (`email-parser-ui`) |
| CloudFront domain | `d2bt5vx8sl8jq9.cloudfront.net` |

**Cleanup (dev):** delete failed service `email-parser-service` if still present (revision 2, 0 tasks).

---

## Master checklist (high level)

### Phase 0 — Docker
- [x] Docker Desktop + `hello-world`
- [x] API image builds; `/api/health` in container

### Phase 1 — Container + registry + secrets
- [x] Dockerfile, ECR, push `latest`
- [x] Secret **`emaildev`** with all 16 keys (see Phase 1)
- [x] IAM execution role + `secretsmanager:GetSecretValue` on `emaildev-*`

### Phase 2 — Network
- [x] Default VPC + `email-parser-alb-sg`, `email-parser-ecs-sg`, `email-parser-rds-sg`
- [x] ALB SG: inbound **80** and **443** (HTTP listener uses 80)

### Phase 3 — Database
- [x] RDS `email-parser-db`, data in `email_parser_import`
- [x] `PG_*` in **`emaildev`** point at RDS (not `localhost`)

### Phase 4 — Backend
- [x] ECS Fargate, desired count **1**, public IP **on**
- [x] ALB + target group; health OK
- [ ] ALB idle timeout **300–600 s** (recommended for long Fetch)

### Phase 5 — Frontend
- [x] S3: `index.html` + `assets/*`
- [x] CloudFront: `/*` → S3, `/api/*` → ALB
- [x] S3 bucket policy (OAC) applied
- [x] WAF: **monitor mode** (see Phase 5 — blocks POST if fully enabled)

### Phase 6 — Hardening / prod
- [x] E2E on CloudFront: Validate + Generate Draft
- [ ] Remove temporary RDS “My IP” SG rule (if added for pgAdmin)
- [ ] WAF tuned or disabled for prod POST bodies
- [ ] Re-add **404 only** SPA error page (avoid **403** → `index.html`)
- [ ] Auth / IP restriction before wide public use
- [ ] Prod account + separate secrets + domains

### Phase 7 — Later
- [ ] CI/CD, Cognito, multi-task + Redis for SSE

---

## Recommended order (new environment)

```text
00 Docker → 01 ECR + secrets → 02 VPC/SG → 03 RDS → 04 ECS/ALB → 05 CloudFront → 06 harden
```

---

## Org setup

| Item | Value |
|------|--------|
| SSO portal | https://d-9667a822b5.awsapps.com/start |
| Dev account | `emailparsing-dev` (`867492128821`) |
| Role for infra | **InfraAdmin** |
| Prod account | `emailparsing-prod` — **read-only; do not deploy until approved** |
| **Region** | **`ap-southeast-1`** only |

---

## Decisions (dev — record for prod)

| Item | Dev choice |
|------|------------|
| AWS region | `ap-southeast-1` |
| Environment | `dev` |
| CLI profile | `emailparser-dev` |
| VPC | **Default** `vpc-03daed954804ba2d9` (no NAT; ECS public IP) |
| Secrets name | **`emaildev`** |
| ECS cluster | `email-parser-cluster` |
| RDS identifier | `email-parser-db` |
| App DB name | `email_parser_import` |
| S3 bucket | `email-parser-ui-867492128821` |
| Public URL | `https://d2bt5vx8sl8jq9.cloudfront.net` |
| API on same host? | **Yes** — `/api/*` → ALB via CloudFront |
| HTTPS on ALB | **No** (HTTP to ALB; HTTPS on CloudFront viewer) |
| WAF | Enabled; **monitor mode** for dev |

---

## Local vs AWS

| | Local | AWS (dev) |
|--|-------|-----------|
| UI | Vite `:5173` | CloudFront → S3 |
| API | `:8000` / proxy | CloudFront `/api/*` → ALB → ECS |
| DB | Laptop Postgres | RDS |
| Secrets | `backend/.env` | Secrets Manager `emaildev` |
| SSE | In-memory, 1 process | **1 ECS task** only |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| ECS task stops: `AccessDenied` on secret | IAM execution role | Add `GetSecretValue` on `arn:...:secret:emaildev-*` |
| ECS task stops: `ResourceNotFound` on secret | Wrong ARN suffix in task def | Use exact suffix from console (`4sFMnJ`, not `4sFMnJyh`) |
| `ValueFrom` / SSM invalid | Typed secret value instead of ARN | Use `arn:...:secret:emaildev-4sFMnJ:KEY_NAME::` |
| ALB NXDOMAIN | Wrong DNS digit | Copy ALB DNS from EC2 (ends in **385**) |
| CloudFront `/` Access Denied XML | S3 OAC policy missing | Apply bucket policy from CloudFront banner |
| Generate Draft: HTML not JSON | Custom error pages or POST to S3 | Delete 403/404 error pages; fix `/api/*` behavior |
| Generate Draft: **403** | WAF blocking POST | WAF → **monitor mode** or disable |
| `/api/*` shows `Server: AmazonS3` on POST | Default behavior or caching | `/api/*` → ALB, **CachingDisabled**, allow **POST** |

Details: [06-verification-hardening.md](./06-verification-hardening.md), [05-frontend-s3-cloudfront.md](./05-frontend-s3-cloudfront.md).

---

## Release runbook (each deploy)

```text
1. backend: docker build → tag → push ECR :latest (or :vX.Y)
2. ECS: new task definition revision if env/secrets change → Update service → Force new deployment
3. frontend: npm run build → upload dist/ to S3 (index.html + assets/)
4. CloudFront: invalidation /*
5. Smoke: /api/health → Fetch (optional) → Generate Draft
```

---

## Moving to production

1. Repeat phases in **`emailparsing-prod`** with **new** secret, RDS, bucket, cluster (do not share dev credentials).
2. Use **private RDS** (no public access); no laptop IP on `rds-sg`.
3. Tune **WAF** with manager (allow large `POST /api/generate-draft` or scope exclusions).
4. **Custom domain** + ACM cert on CloudFront (`us-east-1`).
5. **HTTPS** on ALB optional if CloudFront is the only public entry.
6. See [07-future-improvements.md](./07-future-improvements.md) for auth, CI/CD, scaling.

---

## Getting help

Say in chat: **“Phase 4 stuck”** or **“Prod cutover”** — keep this folder as source of truth.
