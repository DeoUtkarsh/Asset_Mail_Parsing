# Phase 3 — RDS PostgreSQL + schema

**Goal:** PostgreSQL on RDS; app uses `PG_*` from Secrets Manager. Tables are created by the
backend on startup (`pg_db.py`) when it can connect.

**Status:** ✅ Done (dev)

---

## Dev values

| Setting | Value |
|---------|--------|
| Instance ID | `email-parser-db` |
| Engine | PostgreSQL |
| Class | `db.t3.micro` (dev) |
| Endpoint | `email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com` |
| **Active app database** | **`email_parser`** (underscore) |
| Legacy / backup database | `email_parser_import` (old import data — app no longer points here) |
| Master user | `postgres` |
| Public access | Often **Yes** temporarily for pgAdmin — prefer **No** for prod |
| Security group | `email-parser-rds-sg` |

---

## Checklist

- [x] RDS in default VPC subnet group
- [x] Database **`email_parser`** created (`CREATE DATABASE email_parser;`)
- [x] `emaildev`: `PG_HOST`, `PG_DATABASE=email_parser`, `PG_PASSWORD`
- [x] `email-parser-rds-sg` allows **5432** from **`email-parser-ecs-sg`**
- [x] ECS health `"db":"ok"`; startup creates tables automatically

---

## Step 3.1 — Create RDS (already done in this account)

| Setting | Dev |
|---------|-----|
| Identifier | `email-parser-db` |
| VPC | `vpc-03daed954804ba2d9` |
| Security group | `email-parser-rds-sg` |

---

## Step 3.2 — Create / refresh the app database

Connect with pgAdmin (SSL **Require**) to maintenance DB `postgres`, then:

```sql
CREATE DATABASE email_parser;
```

You normally **do not** need to run `schema.sql` by hand. When ECS starts with
`PG_DATABASE=email_parser`, the API runs idempotent DDL and seeds column definitions.

Optional manual apply:

```powershell
psql -h email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com -U postgres -d email_parser -f schema.sql
```

---

## Step 3.3 — Security group (critical)

**`email-parser-rds-sg` inbound must include:**

| Type | Port | Source |
|------|------|--------|
| PostgreSQL | 5432 | Security group **`email-parser-ecs-sg`** (`sg-…`) |
| PostgreSQL | 5432 | My IP (optional, for pgAdmin only) |

If ECS logs show **`connection timed out`** to RDS, the ECS→RDS rule is missing.
My IP alone is enough for pgAdmin but **not** for Fargate tasks.

---

## Step 3.4 — Update secret `emaildev`

```text
PG_HOST=email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com
PG_PORT=5432
PG_DATABASE=email_parser
PG_USER=postgres
PG_PASSWORD=<rds-master-password>
```

> Use **`email_parser`** (underscore). A hyphenated name like `email-parser` is a **different** database.

Force a new ECS deployment after changing the secret.

---

## Step 3.5 — Admin access (dev)

| Method | Notes |
|--------|--------|
| Public access + My IP on `rds-sg` | Convenient for pgAdmin — remove when done |
| ECS only (private) | Preferred for prod |

---

## Prod checklist

- [ ] `Public access = No`
- [ ] Private subnets; no laptop IP on `rds-sg`
- [ ] Automated backups
- [ ] Separate prod secret / password

**Next:** [04-backend-ecs-alb.md](./04-backend-ecs-alb.md)
