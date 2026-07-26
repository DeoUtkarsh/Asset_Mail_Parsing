# Phase 8 — Attachment files on S3

**Goal:** Durable storage for email attachment binaries (PDFs, images, etc.) so ECS
redeploys do not wipe files. Local laptop keeps using `backend/attachment_files/` when
the bucket env is empty.

**Status:** ✅ Done (dev)

**Code:** `backend/file_storage.py` — `save_bytes` / `read_bytes` used by ingestion,
extraction, and `GET /api/attachments/{id}/files/{idx}`.

---

## Dev values

| Item | Value |
|------|--------|
| Bucket | **`email-parser-mail`** |
| Region | `ap-southeast-1` |
| Prefix | `attachment_files` |
| Object key shape | `attachment_files/<attachment_id>/<stored_filename>` |
| Task role | `ecsTaskRole-email-parser` |
| Inline policy name | `email-parser-s3-attachments` |

---

## Checklist

- [x] S3 bucket created (Block Public Access **ON**)
- [x] Task role + S3 Get/Put/Head/List policy
- [x] Keys in secret `emaildev`
- [x] Task definition ValueFrom + **Task role** set (not only execution role)
- [x] Startup log: `FILE STORAGE : S3 s3://email-parser-mail/attachment_files/`

---

## Step 8.1 — Create bucket

- Name: `email-parser-mail`
- Region: `ap-southeast-1`
- Block all public access: **ON**

---

## Step 8.2 — IAM task role

1. IAM → Roles → Create role → **ECS Task**
2. Name: **`ecsTaskRole-email-parser`**
3. Inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::email-parser-mail/attachment_files/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::email-parser-mail"
    }
  ]
}
```

4. Attach this role as the ECS task definition **Task role** (runtime).  
   The **execution** role alone cannot write attachments.

---

## Step 8.3 — Secret + task definition

In **`emaildev`**:

| Key | Value |
|-----|--------|
| `ATTACHMENTS_S3_BUCKET` | `email-parser-mail` |
| `ATTACHMENTS_S3_PREFIX` | `attachment_files` |
| `AWS_REGION` | `ap-southeast-1` |

Add matching **ValueFrom** rows on the task definition (see [04-backend-ecs-alb.md](./04-backend-ecs-alb.md)).

Local `.env`: leave `ATTACHMENTS_S3_BUCKET` empty.

---

## Step 8.4 — Verify

1. Force new ECS deployment.
2. CloudWatch: `FILE STORAGE : S3 s3://email-parser-mail/...`
3. **Fetch Emails** with attachments → objects appear under the bucket prefix.
4. Open attachment preview in UI (serves bytes from S3 via API).

---

## Notes

- Metadata (filenames, sizes) stays in Postgres `attachments.files` JSONB.
- Preview images may also be stored as data URLs in DB for inline UI.
- Docker image does **not** include local `attachment_files/` (`.dockerignore`).
