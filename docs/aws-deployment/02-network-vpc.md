# Phase 2 — VPC, subnets, security groups

**Goal:** ALB public; ECS reaches internet (IMAP, NVIDIA); RDS only from ECS.

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
Internet → ALB (public subnets, alb-sg :80/:443)
              → ECS Fargate (public subnets, public IP ON, ecs-sg :8000)
              → RDS (rds-sg :5432 from ecs-sg only)
```

ECS **public IP = on** so tasks reach Gmail + NVIDIA without NAT.

---

## Security groups

### `email-parser-alb-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **80** | `0.0.0.0/0` (HTTP listener) |
| Inbound | **443** | `0.0.0.0/0` (future HTTPS) |
| Outbound | All | default |

### `email-parser-ecs-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **8000** | SG **`email-parser-alb-sg`** |
| Outbound | All | `0.0.0.0/0` |

> Do **not** use the VPC **default** SG on ECS tasks.

### `email-parser-rds-sg`

| Direction | Port | Source |
|-----------|------|--------|
| Inbound | **5432** | SG **`email-parser-ecs-sg`** |
| Inbound | **5432** | **Your IP** (optional, pgAdmin only — **remove for prod**) |
| Outbound | default | |

---

## Prod recommendations

- New VPC with **private subnets** for ECS + RDS, **public** subnets for ALB only, **NAT** for ECS outbound — or keep default VPC pattern only for dev cost savings.
- Never `0.0.0.0/0` on RDS; no laptop IP in prod.

---

## Phase 2 complete when

- [x] Subnet IDs recorded
- [x] Three SGs created with rules above

**Next:** [03-database-rds.md](./03-database-rds.md)
