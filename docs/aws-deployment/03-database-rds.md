# Phase 3 — RDS PostgreSQL + schema + migration

**Goal:** PostgreSQL on RDS; app uses `PG_*` from Secrets Manager.

**Status:** ✅ Done (dev)

---

## Dev values

| Setting | Value |
|---------|--------|
| Instance ID | `email-parser-db` |
| Engine | PostgreSQL |
| Class | `db.t3.micro` (dev) |
| Endpoint | `email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com` |
| Database name | **`email_parser_import`** |
| Master user | `postgres` |
| Public access | **Was enabled** for pgAdmin during setup — **disable for prod** |

---

## Checklist

- [x] RDS created in default VPC subnet group
- [x] `schema.sql` applied / data restored
- [x] **`emaildev`** updated: `PG_HOST`, `PG_DATABASE=email_parser_import`, `PG_PASSWORD`
- [x] ECS health: `"db":"ok"` via ALB and CloudFront

---

## Step 3.1 — Create RDS

| Setting | Dev |
|---------|-----|
| Identifier | `email-parser-db` |
| VPC | `vpc-03daed954804ba2d9` |
| Public access | Yes (dev admin only) → **No for prod** |
| Security group | `email-parser-rds-sg` |

---

## Step 3.2 — Schema and data

```powershell
# Fresh schema
psql -h <RDS_ENDPOINT> -U postgres -d postgres -f schema.sql

# Or restore to separate DB (dev used email_parser_import)
pg_restore -h <RDS_ENDPOINT> -U postgres -d email_parser_import --no-owner backup.dump
```

**pgAdmin:** SSL **Require**; user `postgres`; not `rdsadmin`.

**Restore note:** If tables already exist from `schema.sql`, use `--data-only` or restore into empty DB.

---

## Step 3.3 — Update secret `emaildev`

```text
PG_HOST=email-parser-db.cnc8ykk0yjwb.ap-southeast-1.rds.amazonaws.com
PG_PORT=5432
PG_DATABASE=email_parser_import
PG_USER=postgres
PG_PASSWORD=<rds-master-password>
```

Force new ECS deployment after secret change.

---

## Step 3.4 — Admin access (dev)

| Method | Notes |
|--------|--------|
| Public access + My IP on `rds-sg` | Used for pgAdmin — remove IP rule when done |
| ECS port-forward / bastion | Preferred for prod |

---

## Prod checklist

- [ ] `Public access = No`
- [ ] Private subnets in DB subnet group
- [ ] Automated backups + retention
- [ ] Strong password in prod-only secret
- [ ] No pgAdmin from internet

**Next:** [04-backend-ecs-alb.md](./04-backend-ecs-alb.md)
