# Phase 1 — Containerize API, ECR, Secrets, IAM

**Goal:** Docker image in **ECR**; configuration in **Secrets Manager** (not in image or git).

**Prerequisites:** [Phase 0](./00-docker-setup.md)

**Status:** ✅ Done (dev)

---

## Checklist

- [x] `backend/Dockerfile` + `.dockerignore` (excludes `.env` and `attachment_files/`)
- [x] Local build + health with `PG_HOST=host.docker.internal`
- [x] ECR `email-parser-api:latest` in `ap-southeast-1`
- [x] Secrets Manager secret **`emaildev`**
- [x] IAM **execution** role `ecsTaskExecutionRole-email-parser` + `GetSecretValue` on `emaildev-*`
- [x] IAM **task** role `ecsTaskRole-email-parser` for S3 (see [08-attachments-s3.md](./08-attachments-s3.md))

---

## Dev values

| Item | Value |
|------|--------|
| ECR URI | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Secret name | **`emaildev`** (not the unused `email-parser/dev`) |
| Secret ARN (base) | `arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ` |
| Execution role | `ecsTaskExecutionRole-email-parser` |
| Task role | `ecsTaskRole-email-parser` |

> **Always copy the ARN suffix from the console** — do not invent characters after `4sFMnJ`.

---

## Step 1.1 — Dockerfile

```text
backend/Dockerfile
backend/.dockerignore   # .env, venv, attachment_files/
```

Build context: **`backend/`** only.

---

## Step 1.2 — Build and test locally

```powershell
cd D:\Asset_Modules\Email_Parser_Two\backend
docker build -t email-parser-api:local .
docker run --rm -p 8000:8000 --env-file .env -e PG_HOST=host.docker.internal email-parser-api:local
```

```powershell
curl http://localhost:8000/api/health
```

Expect: `"status":"ok","db":"ok"`.

---

## Step 1.3 — AWS CLI (SSO)

| Prompt | Value |
|--------|--------|
| SSO start URL | `https://d-9667a822b5.awsapps.com/start` |
| Account | `emailparsing-dev` |
| Role | `InfraAdmin` |
| Region | `ap-southeast-1` |
| Profile | `emailparser-dev` |

```powershell
aws sso login --profile emailparser-dev
aws sts get-caller-identity --profile emailparser-dev
```

---

## Step 1.4 — ECR push

```powershell
$AwsProfile = "emailparser-dev"
$ACCOUNT = "867492128821"
$REGION = "ap-southeast-1"
aws ecr get-login-password --region $REGION --profile $AwsProfile | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker tag email-parser-api:local "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/email-parser-api:latest"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/email-parser-api:latest"
```

---

## Step 1.5 — Secrets Manager (`emaildev`)

### Required keys (current app)

| Key | Notes |
|-----|--------|
| `EMAIL_USER` | Broker mailbox |
| `EMAIL_PASSWORD` | Gmail app password |
| `IMAP_SERVER` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `BLOCKED_SENDER_PATTERNS` | Optional; defaults in code if omitted |
| `ANTHROPIC_API_KEY` | **Required** — extraction/draft **and** Vessel Library enrichment (`web_search`) |
| `CLAUDE_MODEL` | e.g. `claude-haiku-4-5` (same model used for enrichment) |
| `PG_HOST` | RDS endpoint (**not** `localhost`) |
| `PG_PORT` | `5432` |
| `PG_DATABASE` | **`email_parser`** (underscore) |
| `PG_USER` | e.g. `postgres` |
| `PG_PASSWORD` | RDS master password |
| `MAX_ATTACHMENTS` | `0` = all new emails |
| `AUTO_FETCH_IMAP_IDLE` | **`true` on ECS** — IMAP IDLE auto-runs Phase 1 when new mail arrives. On **`aws-deployment`** local `.env` keep **`false`** |
| `AUTO_FETCH_IDLE_RECONNECT_SEC` | Optional; default `30` — wait before reconnecting IDLE after errors |
| `ATTACHMENTS_S3_BUCKET` | `email-parser-mail` |
| `ATTACHMENTS_S3_PREFIX` | `attachment_files` |
| `AWS_REGION` | `ap-southeast-1` |

> **No VesselAPI / MyShipTracking keys.** Enrichment is Claude + Anthropic `web_search` only.
> The Anthropic account must allow the web_search server tool; otherwise enrichment logs errors and blanks stay empty.

### Optional / legacy (ignored by current code)

`FILTER_SENDER`, `TARGET_SUBJECT`, `NVIDIA_*`, `VESSELAPI_*`, `MYSHIPTRACKING_*` — may remain in the secret for compatibility; the app ignores them.

---

## Step 1.6 — IAM execution role

1. Create **`ecsTaskExecutionRole-email-parser`**
2. Attach **`AmazonECSTaskExecutionRolePolicy`**
3. Inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-*"
  }]
}
```

Task **role** for S3: see [08-attachments-s3.md](./08-attachments-s3.md).

---

## ECS task definition — secret injection

For each key: **ValueFrom** =

```text
arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ:KEY_NAME::
```

Full list: [04-backend-ecs-alb.md](./04-backend-ecs-alb.md#step-42--environment-variables-valuefrom).

---

## Phase 1 complete when

- [x] ECR has `latest`
- [x] `emaildev` has Anthropic + RDS `PG_*` + S3 keys
- [x] Execution role can read secret

**Next:** [02-network-vpc.md](./02-network-vpc.md)
