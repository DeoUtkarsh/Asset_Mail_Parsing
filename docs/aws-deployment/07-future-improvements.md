# Phase 7 — Future improvements

**After dev is stable on CloudFront.** Not required for first internal use on dev URL.

---

## Authentication

- [ ] Amazon Cognito (or IdP) in front of CloudFront / ALB
- [ ] Block anonymous `/api/fetch-emails` and `/api/generate-draft` (LLM + IMAP cost)

---

## Scale API (SSE)

Today: `sse_manager` is **in-memory** → **ECS desired count = 1**.

To run multiple tasks:

- [ ] Job events in Redis (ElastiCache) or Postgres
- [ ] Or SQS workers + polling UI
- [ ] Sticky sessions alone are **not** sufficient

---

## CI/CD

- [ ] GitHub Actions: test → `docker build` → ECR push (`:git-sha`)
- [ ] ECS deploy on new tag
- [ ] `npm run build` → `s3 sync` → CloudFront invalidation
- [ ] Separate **dev** / **staging** / **prod** accounts or stacks

---

## HTTPS and domains

- [ ] ACM cert in **us-east-1** for CloudFront custom domain
- [ ] Route 53: `app.company.com` → CloudFront
- [ ] Optional: `api.company.com` → ALB (simplifies WAF/SSE; update frontend `BASE` if not using `/api` proxy)

---

## WAF (prod)

Dev uses **monitor mode** because core rules blocked `POST /api/generate-draft`.

- [ ] Scope managed rules to count/block only on UI paths, or
- [ ] Size restrictions / body inspections excluded for `/api/*`, or
- [ ] Separate ALB subdomain without WAF for API

---

## Network (prod)

- [ ] Dedicated VPC: private ECS + RDS, public ALB only
- [ ] NAT Gateway for outbound IMAP/NVIDIA (no public IP on tasks)
- [ ] VPC endpoints for ECR/Secrets/CloudWatch (optional cost tradeoff)

---

## Operations

- [ ] RDS backups + restore drill
- [ ] Alarms: ECS CPU/memory, ALB 5xx, RDS storage, CloudFront 5xx
- [ ] Secret rotation runbook (Gmail app password, NVIDIA key, RDS)
- [ ] ALB idle timeout 300–600 s if Fetch timeouts reported

---

## Cost

- [ ] Right-size Fargate after observing Fetch peak memory
- [ ] Review WAF + CloudFront request charges
- [ ] NAT vs public-IP ECS tradeoff

---

## Architecture split (if CloudFront + SSE painful)

```text
app.domain.com  → CloudFront → S3
api.domain.com  → ALB → ECS
```

Update `frontend/src/services/api.js` `BASE` if API is no longer same-origin.
