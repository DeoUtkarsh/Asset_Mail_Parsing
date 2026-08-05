# Phase 2 — VPC, subnets, security groups

**Goal:** ALB public; ECS reaches internet (IMAP, Anthropic); RDS only from ECS.

**Status:** ✅ Done (dev)

**Decision:** **Default VPC** in `ap-southeast-1` — no custom VPC, no NAT Gateway.

---

## Dev resource IDs

| Resource | ID |
|----------|-----|
| VPC | `vpc-03daed954804ba2d9` |
| IGW | `igw-0e637192ccbda5d05` |
| Subnet 1a | `subnet-01f6ea763ebe504e6` |
| Subnet 1b | `subnet-06ec875c0650458a6` |
| Subnet 1c | `subnet-00970dca290fb5800` |
| ALB SG | `email-parser-alb-sg` |
| ECS SG | `email-parser-ecs-sg` |
| RDS SG | `email-parser-rds-sg` |

---

## Layout (dev)

```text
Internet → ALB (public subnets, alb-sg :80/:443 from 0.0.0.0/0)
              → ECS Fargate (public subnets, public IP ON, ecs-sg :8000)
              → RDS (rds-sg :5432 from ecs-sg; optional My IP for pgAdmin)
              → S3 / Anthropic / Gmail IMAP (ECS outbound)
```

ECS **public IP = on** so tasks reach Gmail + Anthropic (including **web_search** for
vessel-library enrichment) without NAT. No extra SG rules for enrichment — same HTTPS egress.

---

## Security groups

### `email-parser-alb-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **80**, **443** | **`0.0.0.0/0`** (CloudFront edge IPs need this — My IP alone → CloudFront **504**) |

Do not add PostgreSQL here.

### `email-parser-ecs-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **8000** | `email-parser-alb-sg` |
| Outbound | All | `0.0.0.0/0` (IMAP, Anthropic, S3, ECR) |

> Do **not** use the VPC **default** SG on ECS tasks.

### `email-parser-rds-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **5432** | SG **`email-parser-ecs-sg`** (required) |
| Inbound | **5432** | My IP (optional pgAdmin — remove for prod) |

If ECS logs show RDS **connection timed out**, the ecs-sg rule is missing.

---

## Prod recommendations

- New VPC with **private** subnets for ECS + RDS, **public** for ALB, **NAT** for outbound — or keep default VPC only for low-cost dev.
- Never `0.0.0.0/0` on RDS; no laptop IP in prod.

---

## Phase 2 complete when

- [x] Subnet IDs recorded
- [x] Three SGs created with rules above

**Next:** [03-database-rds.md](./03-database-rds.md)
