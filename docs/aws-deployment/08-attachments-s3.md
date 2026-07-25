# Attachments on S3 (ECS)

Local uses `backend/attachment_files/`. On ECS that disk is ephemeral, so use S3.

## Env / secret keys

| Key | Example |
|-----|---------|
| `ATTACHMENTS_S3_BUCKET` | `email-parser-attachments-867492128821` |
| `ATTACHMENTS_S3_PREFIX` | `attachment_files` |
| `AWS_REGION` | `ap-southeast-1` |

Empty `ATTACHMENTS_S3_BUCKET` → local disk (laptop).

## IAM

Create/attach an **ECS task role** (runtime, not only execution role) with:

- `s3:GetObject`
- `s3:PutObject`
- `s3:HeadObject`

on `arn:aws:s3:::YOUR_BUCKET/attachment_files/*` (and optionally `ListBucket` on the bucket).

Object layout: `s3://bucket/attachment_files/<attachment_id>/<stored_filename>`
