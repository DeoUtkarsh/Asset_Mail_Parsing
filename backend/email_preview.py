"""
Extract and sanitize email body content for the attachment preview panel.
Keeps original HTML / plain text / inline images separate from raw_text (LLM input).
"""
from __future__ import annotations

import base64
import email
import re
from email.message import Message
from typing import Any, Optional

_CID_SRC_RE = re.compile(
    r"""(?P<attr>src)\s*=\s*(?P<q>["'])\s*cid:([^"']+)\s*\2""",
    re.IGNORECASE,
)
_EVENT_HANDLER_RE = re.compile(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", re.IGNORECASE | re.DOTALL)
_JAVASCRIPT_URL_RE = re.compile(r"(?i)(href|src)\s*=\s*(['\"])\s*javascript:[^'\"]*\2")
_DANGEROUS_TAGS_RE = re.compile(
    r"(?is)<\s*(script|iframe|object|embed|form|link|meta)\b[^>]*>.*?</\s*\1\s*>"
    r"|<\s*(script|iframe|object|embed|form|link|meta)\b[^>]*/\s*>"
)


def _normalize_cid(raw: str) -> str:
    return (raw or "").strip().strip("<>").lower()


def _part_bytes(part: Message) -> Optional[bytes]:
    payload = part.get_payload(decode=True)
    if isinstance(payload, bytes):
        return payload
    if payload is None:
        pl = part.get_payload(decode=False)
        if isinstance(pl, str):
            return pl.encode("utf-8", errors="replace")
        if isinstance(pl, bytes):
            return pl
        return None
    if isinstance(payload, str):
        return payload.encode("utf-8", errors="replace")
    return None


def _part_text(part: Message) -> str:
    data = _part_bytes(part)
    if not data:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return data.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return data.decode("utf-8", errors="replace")


def _collect_parts(msg: Message) -> tuple[list[str], list[str], dict[str, tuple[str, bytes]], list[dict[str, str]]]:
    """Return html parts, plain parts, cid map, standalone image data URIs."""
    html_parts: list[str] = []
    plain_parts: list[str] = []
    cid_map: dict[str, tuple[str, bytes]] = {}
    standalone_images: list[dict[str, str]] = []

    for part in msg.walk():
        if part.is_multipart():
            continue
        content_type = (part.get_content_type() or "").lower()
        maintype = part.get_content_maintype()

        if maintype == "image":
            raw = _part_bytes(part)
            if not raw:
                continue
            mime = content_type or "image/png"
            data_url = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
            cid_hdr = part.get("Content-ID") or part.get("Content-Id")
            if cid_hdr:
                cid_map[_normalize_cid(cid_hdr)] = (mime, raw)
            else:
                standalone_images.append({"mime": mime, "data_url": data_url})
            continue

        if content_type == "text/html":
            text = _part_text(part).strip()
            if text:
                html_parts.append(text)
        elif content_type == "text/plain":
            text = _part_text(part)
            if text.strip():
                plain_parts.append(text)

    return html_parts, plain_parts, cid_map, standalone_images


def sanitize_preview_html(html: str) -> str:
    """Strip scripts and event handlers; keep layout/styles for broker tables."""
    if not html:
        return ""
    out = _DANGEROUS_TAGS_RE.sub(" ", html)
    out = _EVENT_HANDLER_RE.sub(" ", out)
    out = _JAVASCRIPT_URL_RE.sub(r'\1="#"', out)
    return out.strip()


def resolve_cid_in_html(html: str, cid_map: dict[str, tuple[str, bytes]]) -> str:
    if not html or not cid_map:
        return html

    def repl(match: re.Match) -> str:
        attr = match.group("attr")
        quote = match.group("q")
        cid_key = _normalize_cid(match.group(3))
        entry = cid_map.get(cid_key)
        if not entry:
            return match.group(0)
        mime, raw = entry
        data_url = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        return f'{attr}={quote}{data_url}{quote}'

    return _CID_SRC_RE.sub(repl, html)


def extract_preview_from_message(msg: Message) -> dict[str, Any]:
    """
    Build preview payload for UI.
    Returns: preview_html, preview_plain, preview_images (list), preview_mode hint.
    """
    html_parts, plain_parts, cid_map, standalone_images = _collect_parts(msg)

    best_html = max(html_parts, key=len, default="")
    best_plain = max(plain_parts, key=len, default="")

    if best_html:
        rendered = sanitize_preview_html(resolve_cid_in_html(best_html, cid_map))
        # Include standalone images below HTML when the body is mostly boilerplate
        images = list(standalone_images)
        for _cid, (mime, raw) in cid_map.items():
            if f"cid:{_cid}" in best_html.lower():
                continue
            images.append({
                "mime": mime,
                "data_url": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}",
            })
        mode = "html"
        if not rendered and images:
            mode = "images"
        elif rendered and images and len(re.sub(r"<[^>]+>", "", rendered).strip()) < 80:
            mode = "html_images"
        return {
            "preview_html": rendered or None,
            "preview_plain": best_plain.strip() or None,
            "preview_images": images or None,
            "preview_mode": mode,
        }

    if standalone_images and len(best_plain.strip()) < 400:
        return {
            "preview_html": None,
            "preview_plain": best_plain.strip() or None,
            "preview_images": standalone_images,
            "preview_mode": "images",
        }

    if best_plain.strip():
        return {
            "preview_html": None,
            "preview_plain": best_plain.replace("\r\n", "\n").replace("\r", "\n").strip(),
            "preview_images": standalone_images or None,
            "preview_mode": "plain",
        }

    if standalone_images:
        return {
            "preview_html": None,
            "preview_plain": None,
            "preview_images": standalone_images,
            "preview_mode": "images",
        }

    return {
        "preview_html": None,
        "preview_plain": None,
        "preview_images": None,
        "preview_mode": "none",
    }


def extract_preview_from_bytes(raw_bytes: bytes) -> dict[str, Any]:
    from email import message_from_bytes
    import email.policy

    msg = message_from_bytes(raw_bytes, policy=email.policy.compat32)
    return extract_preview_from_message(msg)
