# Phase 1 — Containerize API, ECR, Secrets, IAM

**Goal:** Docker image in **ECR**; configuration in **Secrets Manager** (not in image or git).

**Prerequisites:** [Phase 0](./00-docker-setup.md)

**Status:** ✅ Done (dev)

---

## Checklist

- [x] `backend/Dockerfile` + `.dockerignore`
- [x] Local build + health with `PG_HOST=host.docker.internal`
- [x] ECR `email-parser-api:latest` in `ap-southeast-1`
- [x] Secrets Manager secret **`emaildev`** (16 keys)
- [x] IAM role `ecsTaskExecutionRole-email-parser` + policy on `emaildev-*`

---

## Dev values

| Item | Value |
|------|--------|
| ECR URI | `867492128821.dkr.ecr.ap-southeast-1.amazonaws.com/email-parser-api:latest` |
| Secret name | **`emaildev`** |
| Secret ARN (base) | `arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ` |
| Execution role | `ecsTaskExecutionRole-email-parser` |

> Secret name in early notes was `email-parser/dev` — **deployed secret is `emaildev`**. Use the name and ARN suffix from the console.

---

## Step 1.1 — Dockerfile

```text
backend/Dockerfile
backend/.dockerignore   # excludes .env
```

Build context: **`backend/`** folder only.

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

PowerShell (avoid `$PROFILE` — reserved):

```powershell
$AwsProfile = "emailparser-dev"
$REGION = "ap-southeast-1"
```

---

## Step 1.4 — ECR push

```powershell
$ACCOUNT = "867492128821"
$REGION = "ap-southeast-1"
aws ecr get-login-password --region $REGION --profile $AwsProfile | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker tag email-parser-api:local "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/email-parser-api:latest"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/email-parser-api:latest"
```

---

## Step 1.5 — Secrets Manager

**Console:** Secrets Manager → **Store a new secret** → key/value → name: **`emaildev`**

### Required keys (16)

| Key | Dev notes |
|-----|-----------|
| `EMAIL_USER` | Gmail |
| `EMAIL_PASSWORD` | Gmail app password |
| `FILTER_SENDER` | |
| `TARGET_SUBJECT` | |
| `IMAP_SERVER` | `imap.gmail.com` |
| `IMAP_PORT` | `993` |
| `NVIDIA_API_KEY` | |
| `NVIDIA_API_BASE_URL` | |
| `NVIDIA_LLM_MODEL` | |
| `NVIDIA_PARSE_MODEL` | |
| `PG_HOST` | RDS endpoint (Phase 3), **not** `localhost` |
| `PG_PORT` | `5432` |
| `PG_DATABASE` | **`email_parser_import`** (dev) |
| `PG_USER` | e.g. `postgres` |
| `PG_PASSWORD` | RDS master password |
| `MAX_ATTACHMENTS` | `0` |

---

## Step 1.6 — IAM execution role

1. **IAM** → **Roles** → create **`ecsTaskExecutionRole-email-parser`**
2. Attach **`AmazonECSTaskExecutionRolePolicy`**
3. Inline policy (adjust secret name for prod):

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

---

## ECS task definition — secret injection

Console only shows **Value** / **ValueFrom**. For each env var:

- **Type:** `ValueFrom`
- **Value:** `arn:aws:secretsmanager:ap-southeast-1:867492128821:secret:emaildev-4sFMnJ:EMAIL_USER::`

Replace `EMAIL_USER` with each key. **Copy ARN suffix from console** (`4sFMnJ` — do not add extra characters like `yh`).

Full list: see [04-backend-ecs-alb.md](./04-backend-ecs-alb.md#step-42--environment-variables-valuefrom).

---

## Phase 1 complete when

- [x] ECR has `latest`
- [x] Secret `emaildev` has RDS `PG_*`
- [x] Execution role can read secret

**Next:** [02-network-vpc.md](./02-network-vpc.md)
