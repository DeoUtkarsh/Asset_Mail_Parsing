# Phase 4 — ECS Fargate + ALB

**Goal:** FastAPI on AWS; health `/api/health`; single task for SSE; secrets + S3 task role.

**Status:** ✅ Done (dev)

---

## Dev values

| Item | Value |
|------|--------|
| Cluster | `email-parser-cluster` |
| Service (active) | `email-parser-api-service-khf6bfgk` |
| Task definition family | `email-parser-api` (use **latest** revision) |
| Log group | `/ecs/email-parser-api` |
| Execution role | `ecsTaskExecutionRole-email-parser` |
| **Task role** | **`ecsTaskRole-email-parser`** (S3 attachments) |
| ALB | `email-parser-alb` |
| ALB DNS | `email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com` |
| Target group | `email-parser-tg` (IP, port **8000**, health `/api/health`) |
| Listener | **HTTP 80** → target group |
| Container SG | **`email-parser-ecs-sg`** only |

---

## Checklist

- [x] CloudWatch log group
- [x] Task definition: ECR image + ValueFrom secrets + **task role**
- [x] Service: desired **1**, public IP **on**
- [x] ALB + target group; health OK
- [ ] ALB idle timeout **300–600 s** (recommended for long Fetch)

---

## Step 4.1 — CloudWatch

Log group: **`/ecs/email-parser-api`**.

Healthy startup should log roughly:

```text
EMAIL_USER       : …
CLAUDE_MODEL     : …
DB               : … / email_parser
FILE STORAGE     : S3 s3://email-parser-mail/attachment_files/
PostgreSQL connection: OK
Application startup complete.
```

---

## Step 4.2 — Task definition

| Field | Value |
|-------|--------|
| Family | `email-parser-api` |
| Launch | Fargate, 1 vCPU, 2–3 GB |
| Image | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Container | `api`, port **8000** |
| **Task role** | `ecsTaskRole-email-parser` |
| Execution role | `ecsTaskExecutionRole-email-parser` |
| Logs | `awslogs` → `/ecs/email-parser-api` |

### Environment variables (ValueFrom)

Base ARN (verify suffix in console):

```text
arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ
```

**Required for current app:**

```text
EMAIL_USER
EMAIL_PASSWORD
IMAP_SERVER
IMAP_PORT
ANTHROPIC_API_KEY
CLAUDE_MODEL
PG_HOST
PG_PORT
PG_DATABASE
PG_USER
PG_PASSWORD
MAX_ATTACHMENTS
ATTACHMENTS_S3_BUCKET
ATTACHMENTS_S3_PREFIX
AWS_REGION
```

**Optional:**

```text
BLOCKED_SENDER_PATTERNS
```

**Legacy (optional; unused by current code):**

```text
FILTER_SENDER
TARGET_SUBJECT
NVIDIA_API_BASE_URL
NVIDIA_API_KEY
NVIDIA_LLM_MODEL
NVIDIA_PARSE_MODEL
```

Example:

```text
arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ:ANTHROPIC_API_KEY::
```

**Common mistakes:** typo in ARN suffix; pasting plaintext into ValueFrom; forgetting **task role** (S3 Put/Get fails); forgetting Anthropic keys (task crashes on import).

---

## Step 4.3 — ECS service

| Field | Value |
|-------|--------|
| Cluster | `email-parser-cluster` |
| Task definition | Latest revision |
| Desired count | **1** |
| Subnets | 2+ public subnets |
| Security group | **`email-parser-ecs-sg`** |
| Public IP | **On** |
| Load balancer | `email-parser-alb` → `email-parser-tg` |
| Health check grace | **180** s |

```cmd
aws ecs update-service --cluster email-parser-cluster --service email-parser-api-service-khf6bfgk --task-definition email-parser-api:N --force-new-deployment --region ap-southeast-1 --profile emailparser-dev
```

Replace `N` with the latest revision number.

---

## Step 4.4 — ALB security group

**`email-parser-alb-sg` inbound** (required for CloudFront → ALB):

| Type | Port | Source |
|------|------|--------|
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` (optional) |

If source is only **My IP**, CloudFront returns **504** while direct ALB from your laptop may still work.

Do **not** put PostgreSQL rules on the ALB SG.

---

## Step 4.5 — Smoke tests

```text
GET http://email-parser-alb-656767385.ap-southeast-1.elb.amazonaws.com/api/health
GET https://d2bt5vx8sl8jq9.cloudfront.net/api/health
GET https://d2bt5vx8sl8jq9.cloudfront.net/api/home/summary
```

---

## Known image dependency

Pin **`httpx==0.27.2`** with `anthropic==0.39.0` or the container crashes:

```text
TypeError: AsyncClient.__init__() got an unexpected keyword argument 'proxies'
```

Already set in `backend/requirements.txt`.

---

## Single task (SSE)

Do **not** set desired count > 1 until job events use Redis/DB. See [07-future-improvements.md](./07-future-improvements.md).

**Next:** [05-frontend-s3-cloudfront.md](./05-frontend-s3-cloudfront.md) · [08-attachments-s3.md](./08-attachments-s3.md)
