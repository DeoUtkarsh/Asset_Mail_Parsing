"""
Central LLM client — Anthropic Claude (text + vision + PDF).

Exposes `claude_client`, a thin adapter whose surface mimics the small slice of
the OpenAI SDK the agents already use:

    resp = await claude_client.chat.completions.create(
        model=settings.CLAUDE_MODEL,
        messages=[{"role": "system", "content": "..."},
                  {"role": "user", "content": "..."}],
        temperature=0.2,
        max_tokens=1024,
    )
    text = resp.choices[0].message.content

A message's `content` may be a plain string (text) OR a list of Anthropic
content blocks (for vision/PDF). Use `files_to_content_blocks()` to turn email
attachments (images / PDF / Excel / CSV / Word) into those blocks.
"""
from __future__ import annotations

import base64
import csv
import io
import logging
import os
from typing import Any

from anthropic import AsyncAnthropic

from config import settings

logger = logging.getLogger(__name__)

_client = AsyncAnthropic(
    api_key=settings.ANTHROPIC_API_KEY,
    max_retries=1,
    timeout=20.0,
)

# Anthropic-supported image media types (others are converted to PNG).
_IMAGE_MEDIA = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_IMAGE_EXT_MEDIA = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff",
}
# Claude vision guidance: keep the long edge <= ~1568px and payload < ~5MB.
_IMG_MAX_EDGE = 1568
_IMG_MAX_BYTES = 4_500_000


# ── OpenAI-shaped response wrappers ──────────────────────────────────────────
class _Message:
    def __init__(self, content: str) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: str) -> None:
        self.message = _Message(content)


class _Response:
    def __init__(self, content: str) -> None:
        self.choices = [_Choice(content)]


class _Completions:
    async def create(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        temperature: float = 0.2,
        max_tokens: int = 1024,
        timeout: float | None = 20.0,
        **_ignored: Any,
    ) -> _Response:
        system_parts: list[str] = []
        conv: list[dict[str, Any]] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if role == "system":
                if isinstance(content, str):
                    system_parts.append(content)
                continue
            conv.append({
                "role": "assistant" if role == "assistant" else "user",
                "content": content,
            })
        if not conv:
            conv = [{"role": "user", "content": ""}]

        kwargs: dict[str, Any] = {
            "model": model or settings.CLAUDE_MODEL,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": conv,
        }
        if system_parts:
            kwargs["system"] = "\n\n".join(system_parts)

        client = _client.with_options(timeout=timeout) if timeout else _client
        resp = await client.messages.create(**kwargs)
        text = "".join(
            block.text for block in resp.content
            if getattr(block, "type", "") == "text"
        )
        return _Response(text)


class _Chat:
    def __init__(self) -> None:
        self.completions = _Completions()


class ClaudeClient:
    def __init__(self) -> None:
        self.chat = _Chat()


claude_client = ClaudeClient()


# ── File → Anthropic content blocks ──────────────────────────────────────────
def _guess_media_type(name: str, content_type: str) -> str:
    ct = (content_type or "").lower().split(";")[0].strip()
    ext = os.path.splitext(name or "")[1].lower()
    if ct in _IMAGE_MEDIA or ct == "application/pdf":
        return ct
    if ext in _IMAGE_EXT_MEDIA:
        return _IMAGE_EXT_MEDIA[ext]
    if ext == ".pdf":
        return "application/pdf"
    return ct or "application/octet-stream"


def _image_block(name: str, media_type: str, content: bytes) -> dict[str, Any] | None:
    try:
        data = content
        # Convert unsupported types (bmp/tiff) or oversized images via Pillow.
        needs_convert = media_type not in _IMAGE_MEDIA
        too_big = len(data) > _IMG_MAX_BYTES
        if needs_convert or too_big:
            try:
                from PIL import Image  # local import; optional dep
                img = Image.open(io.BytesIO(data))
                img = img.convert("RGB")
                w, h = img.size
                scale = min(1.0, _IMG_MAX_EDGE / max(w, h))
                if scale < 1.0:
                    img = img.resize((int(w * scale), int(h * scale)))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
                data = buf.getvalue()
                media_type = "image/jpeg"
            except Exception as exc:  # noqa: BLE001
                if needs_convert:
                    logger.warning("Image %s unsupported and PIL failed: %s", name, exc)
                    return None
                # oversized but convert failed → send original best-effort
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.standard_b64encode(data).decode("ascii"),
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to build image block for %s: %s", name, exc)
        return None


def _pdf_block(content: bytes) -> dict[str, Any]:
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": base64.standard_b64encode(content).decode("ascii"),
        },
    }


def _xlsx_to_text(content: bytes, name: str) -> str:
    try:
        from openpyxl import load_workbook  # local import; optional dep
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        lines: list[str] = []
        for ws in wb.worksheets:
            lines.append(f"# Sheet: {ws.title}")
            for row in ws.iter_rows(values_only=True):
                cells = ["" if c is None else str(c) for c in row]
                if any(cells):
                    lines.append("\t".join(cells))
        return "\n".join(lines).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to read spreadsheet %s: %s", name, exc)
        return ""


def _csv_to_text(content: bytes) -> str:
    try:
        text = content.decode("utf-8", errors="replace")
        reader = csv.reader(io.StringIO(text))
        return "\n".join("\t".join(row) for row in reader).strip()
    except Exception:  # noqa: BLE001
        return content.decode("utf-8", errors="replace").strip()


def _docx_to_text(content: bytes, name: str) -> str:
    try:
        import docx  # python-docx; local import
        doc = docx.Document(io.BytesIO(content))
        parts: list[str] = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells]
                if any(cells):
                    parts.append("\t".join(cells))
        return "\n".join(parts).strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to read Word doc %s: %s", name, exc)
        return ""


def file_to_content_blocks(f: dict) -> list[dict[str, Any]]:
    """Convert one attachment dict {filename/name, content_type, content} into
    zero or more Anthropic content blocks."""
    name = f.get("filename") or f.get("name") or ""
    content = f.get("content")
    if not content:
        return []
    media = _guess_media_type(name, f.get("content_type") or "")
    ext = os.path.splitext(name)[1].lower()

    # Images
    if media in _IMAGE_MEDIA or media.startswith("image/") or ext in _IMAGE_EXT_MEDIA:
        block = _image_block(name, media if media.startswith("image/") else "image/png", content)
        return [block] if block else []

    # PDF (native)
    if media == "application/pdf" or ext == ".pdf":
        return [_pdf_block(content)]

    # Spreadsheets / CSV / Word → text
    text = ""
    if ext in (".xlsx", ".xlsm", ".xls") or "spreadsheet" in media or "excel" in media:
        text = _xlsx_to_text(content, name)
    elif ext == ".csv" or media == "text/csv":
        text = _csv_to_text(content)
    elif ext in (".docx",) or "wordprocessingml" in media:
        text = _docx_to_text(content, name)
    elif media.startswith("text/") or ext in (".txt", ".eml"):
        text = content.decode("utf-8", errors="replace").strip()

    if text:
        return [{"type": "text", "text": f"[Attachment: {name}]\n{text[:20000]}"}]

    logger.info("Skipping unsupported attachment %s (%s)", name, media)
    return []


def files_to_content_blocks(files: list[dict]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for f in files or []:
        blocks.extend(file_to_content_blocks(f))
    return blocks
