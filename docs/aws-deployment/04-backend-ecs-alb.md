# Phase 4 — ECS Fargate + ALB

**Goal:** FastAPI on AWS; health `/api/health`; single task for SSE.

**Status:** ✅ Done (dev)

---

## Dev values

| Item | Value |
|------|--------|
| Cluster | `email-parser-cluster` |
| Service (active) | `email-parser-api-service-khf6bfgk` |
| Service (remove) | `email-parser-service` (failed — delete) |
| Task definition | `email-parser-api:3` |
| Log group | `/ecs/email-parser-api` |
| Execution role | `ecsTaskExecutionRole-email-parser` |
| ALB | `email-parser-alb` |
| ALB DNS | `email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com` |
| Target group | `email-parser-tg` (IP, port **8000**, health `/api/health`) |
| Listener | **HTTP 80** → target group |

---

## Checklist

- [x] CloudWatch log group
- [x] Task definition with ECR image + **ValueFrom** secrets
- [x] Service: desired **1**, public IP **on**, `email-parser-ecs-sg`
- [x] ALB + existing target group (do not create duplicate ALB for same app)
- [x] `http://<alb-dns>/api/health` → `{"status":"ok","db":"ok"}`
- [ ] ALB idle timeout **300–600 s** (long Fetch / SSE)

---

## Step 4.1 — CloudWatch

Log group: **`/ecs/email-parser-api`** (retention 1 week OK for dev).

---

## Step 4.2 — Task definition

| Field | Value |
|-------|--------|
| Family | `email-parser-api` |
| Launch | Fargate, 1 vCPU, 2–3 GB |
| Image | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Container name | `api` |
| Port | **8000** |
| Execution role | `ecsTaskExecutionRole-email-parser` |
| Logs | `awslogs` → `/ecs/email-parser-api` |

### Environment variables (ValueFrom)

Base ARN (verify suffix in console):

```text
arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ
```

Each row: **Key** = name below, **ValueFrom** = `BASE:KEY::`

```text
EMAIL_USER
EMAIL_PASSWORD
IMAP_SERVER
IMAP_PORT
FILTER_SENDER
TARGET_SUBJECT
NVIDIA_API_BASE_URL
NVIDIA_API_KEY
NVIDIA_LLM_MODEL
NVIDIA_PARSE_MODEL
PG_HOST
PG_PORT
PG_DATABASE
PG_USER
PG_PASSWORD
MAX_ATTACHMENTS
```

Example:

```text
arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ:EMAIL_USER::
```

**Common mistakes:** typo `4sFMnJyh`; pasting email/password in ValueFrom; using `email-parser/dev` ARN when secret is `emaildev`.

---

## Step 4.3 — ECS service

| Field | Value |
|-------|--------|
| Cluster | `email-parser-cluster` |
| Task definition | Latest revision |
| Desired count | **1** |
| Subnets | 2+ public subnets (e.g. 1a + 1b) |
| Security group | **`email-parser-ecs-sg`** only |
| Public IP | **Turned on** |
| Load balancer | Existing **`email-parser-alb`**, listener **HTTP 80**, TG **`email-parser-tg`** |
| Health check grace period | **180** s |

**Update after task def change:** Service → **Update** → new revision → **Force new deployment**.

---

## Step 4.4 — ALB (already created in dev)

Target group: type **IP**, port **8000**, health path **`/api/health`**, matcher **200**.

ALB SG must allow **80** (and 443 if added later).

---

## Step 4.5 — Smoke tests

```text
GET http://email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com/api/health
GET http://email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com/docs
```

---

## IAM errors (reference)

| Error | Fix |
|-------|-----|
| `AccessDenied` on `GetSecretValue` | IAM policy on `emaildev-*` |
| `ResourceNotFound` on secret | Fix ARN suffix in task definition |

---

## Single task (SSE)

Do **not** scale desired count > 1 until job events use Redis/DB. See [07-future-improvements.md](./07-future-improvements.md).

**Next:** [05-frontend-s3-cloudfront.md](./05-frontend-s3-cloudfront.md)
