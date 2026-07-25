"""
Attachment file storage — local disk (dev) or S3 (AWS).

Local:  attachment_files/<att_id>/<stored>
S3:     s3://{bucket}/{prefix}/{att_id}/{stored}

Set ATTACHMENTS_S3_BUCKET to enable S3. Leave empty for local disk.
On ECS, use a task role with s3:GetObject/PutObject (no keys in .env).
"""
from __future__ import annotations

import logging
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

FILES_DIR = Path(__file__).resolve().parent / "attachment_files"


def uses_s3() -> bool:
    return bool((settings.ATTACHMENTS_S3_BUCKET or "").strip())


def _s3_key(att_id: str, stored: str) -> str:
    prefix = (settings.ATTACHMENTS_S3_PREFIX or "attachment_files").strip().strip("/")
    return f"{prefix}/{att_id}/{stored}"


def _s3_client():
    import boto3

    kwargs = {}
    region = (settings.AWS_REGION or "").strip()
    if region:
        kwargs["region_name"] = region
    return boto3.client("s3", **kwargs)


def save_bytes(att_id: str, stored: str, content: bytes) -> None:
    """Persist one attachment file bytes under att_id/stored."""
    if uses_s3():
        bucket = settings.ATTACHMENTS_S3_BUCKET.strip()
        key = _s3_key(att_id, stored)
        _s3_client().put_object(Bucket=bucket, Key=key, Body=content)
        logger.debug("Saved s3://%s/%s (%d bytes)", bucket, key, len(content))
        return

    dest = FILES_DIR / att_id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / stored).write_bytes(content)


def read_bytes(att_id: str, stored: str) -> bytes:
    """Load one attachment file; raises FileNotFoundError if missing."""
    if uses_s3():
        bucket = settings.ATTACHMENTS_S3_BUCKET.strip()
        key = _s3_key(att_id, stored)
        try:
            obj = _s3_client().get_object(Bucket=bucket, Key=key)
            return obj["Body"].read()
        except Exception as exc:  # noqa: BLE001
            raise FileNotFoundError(f"s3://{bucket}/{key}") from exc

    path = FILES_DIR / att_id / stored
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path.read_bytes()


def exists(att_id: str, stored: str) -> bool:
    try:
        if uses_s3():
            bucket = settings.ATTACHMENTS_S3_BUCKET.strip()
            key = _s3_key(att_id, stored)
            _s3_client().head_object(Bucket=bucket, Key=key)
            return True
        return (FILES_DIR / att_id / stored).is_file()
    except Exception:  # noqa: BLE001
        return False
