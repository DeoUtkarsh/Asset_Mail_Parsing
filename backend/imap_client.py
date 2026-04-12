"""
IMAP client: connects to Gmail, finds the target email, and extracts
raw text from every .eml attachment (or message/rfc822 part).
"""
import html as html_module
import imaplib
import email
import email.policy
import re
import logging
from email import message_from_bytes
from email.header import decode_header
from email.message import Message
from typing import Optional
from urllib.parse import unquote

from config import settings

logger = logging.getLogger(__name__)


def _decode_header_value(raw: str) -> str:
    parts = decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def _parse_filename_from_content_disposition(cd: str) -> str:
    """Best-effort filename from Content-Disposition when get_filename() is empty."""
    if not cd:
        return ""
    # RFC 5987: filename*=UTF-8''percent-encoded
    m = re.search(r"filename\*\s*=\s*([^']*)'[^']*'([^;\s]+)", cd, re.I)
    if m:
        try:
            return unquote(m.group(2).strip().strip('"'))
        except Exception:
            pass
    m = re.search(r'filename\*\s*=\s*UTF-8\'\'([^;\s]+)', cd, re.I)
    if m:
        try:
            return unquote(m.group(1).strip().strip('"'))
        except Exception:
            pass
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"filename\s*=\s*([^;\s]+)", cd, re.I)
    if m:
        return m.group(1).strip().strip('"')
    return ""


def _declared_filename(part: email.message.Message) -> str:
    """
    Filename only if the MIME tree actually declares one (Content-Disposition,
    get_filename, Content-Type name=). Empty string if none — do NOT invent
    'attachment_NNN.eml' here, or text/plain + text/html body parts would look
    like .eml attachments (they use the same synthetic suffix elsewhere).
    """
    fn_raw = part.get_filename()
    if fn_raw:
        return _decode_header_value(fn_raw)
    cd = part.get("Content-Disposition") or ""
    parsed = _parse_filename_from_content_disposition(cd)
    if parsed:
        return parsed
    try:
        ctype = part.get_content_type()
        if ctype:
            name = part.get_param("name", header="content-type")
            if name:
                return _decode_header_value(name)
    except Exception:
        pass
    return ""


_GENERIC_ATTACHMENT_RE = re.compile(r"^attachment_\d+\.eml$", re.I)
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_RE_FWD_SUBJ = re.compile(r"^\s*(re|fw|fwd)\s*:\s*", re.I)


def _slug_filename_from_subject(subject: str) -> str:
    """Build a filesystem-safe .eml name from an inner email Subject."""
    if not subject:
        return ""
    line = _decode_header_value(subject).split("\n")[0].strip()
    line = re.sub(r"^=\s+", "", line).strip()
    line = _RE_FWD_SUBJ.sub("", line).strip()
    line = _INVALID_FILENAME_CHARS.sub("_", line)
    line = re.sub(r"\s+", " ", line).strip()
    if not line:
        return ""
    if len(line) > 120:
        line = line[:117].rstrip() + "..."
    base = line if line.lower().endswith(".eml") else f"{line}.eml"
    return base


def _unique_filename(name: str, used: set[str]) -> str:
    if name not in used:
        used.add(name)
        return name
    if name.lower().endswith(".eml"):
        stem, ext = name[:-4], ".eml"
    else:
        stem, ext = name, ""
    n = 2
    while True:
        candidate = f"{stem}_{n}{ext}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        n += 1


def _get_inner_message_any(part: email.message.Message) -> Optional[Message]:
    """
    Gmail / IMAP often expose message/rfc822 as raw bytes, or a single Message,
    or a one-element list — normalize to a parsed Message.
    """
    payload = part.get_payload(decode=False)
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, Message):
                return item
        payload = payload[0] if payload else None
    if isinstance(payload, Message):
        return payload
    raw = part.get_payload(decode=True)
    if isinstance(raw, bytes) and raw.strip():
        try:
            return message_from_bytes(raw, policy=email.policy.compat32)
        except Exception:
            pass
    if isinstance(payload, str) and payload.strip():
        try:
            return message_from_bytes(payload.encode("utf-8", errors="replace"), policy=email.policy.compat32)
        except Exception:
            pass
    return None


_SUBJECT_LINE_RE = re.compile(r"^\s*Subject:\s*(.+)$", re.I)


def _filename_hint_from_body(text: str) -> str:
    """When MIME has no name, forwarded bodies often start with Subject: lines."""
    if not text:
        return ""
    for line in text.strip().splitlines()[:80]:
        m = _SUBJECT_LINE_RE.match(line)
        if m:
            return _slug_filename_from_subject(m.group(1).strip())
    return ""


def _maybe_better_filename(
    filename: str,
    content_type: str,
    part: email.message.Message,
    raw_bytes: Optional[bytes],
    raw_text: str,
) -> str:
    """Prefer inner Subject, then a Subject: line in the extracted body, for generic names."""
    if not _GENERIC_ATTACHMENT_RE.match(filename):
        return filename
    inner: Optional[Message] = None
    if content_type == "message/rfc822":
        inner = _get_inner_message_any(part)
    elif raw_bytes:
        try:
            inner = message_from_bytes(raw_bytes, policy=email.policy.compat32)
        except Exception:
            inner = None
    if inner is not None:
        subj = _decode_header_value(inner.get("Subject") or "")
        better = _slug_filename_from_subject(subj)
        if better:
            return better
    hint = _filename_hint_from_body(raw_text)
    return hint if hint else filename


def _strip_html_to_text(s: str) -> str:
    """Remove script/style blocks and tags; keep some structure (signatures, lists)."""
    if not s:
        return ""
    t = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", s)
    t = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", t)
    t = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", t)
    t = re.sub(r"(?i)</\s*(?:p|div|tr|h[1-6]|table|li|section)\s*>", "\n", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = html_module.unescape(t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _looks_like_markup(s: str) -> bool:
    if not s or len(s) < 12:
        return False
    head = s.lstrip()[:200].lower()
    return "<html" in head or "<!doctype" in head or head.startswith("<meta")


def _extract_text_from_message(msg: email.message.Message) -> str:
    """Recursively extract all human-readable text from an email Message."""
    text_parts: list[str] = []

    def walk(part: email.message.Message) -> None:
        content_type = part.get_content_type()

        if part.is_multipart():
            for sub in part.get_payload():
                walk(sub)
            return

        payload = part.get_payload(decode=True)
        if payload is None:
            pl = part.get_payload(decode=False)
            if isinstance(pl, str):
                text = pl
            elif isinstance(pl, bytes):
                charset = part.get_content_charset() or "utf-8"
                try:
                    text = pl.decode(charset, errors="replace")
                except (LookupError, UnicodeDecodeError):
                    text = pl.decode("utf-8", errors="replace")
            else:
                return
        elif isinstance(payload, str):
            text = payload
        else:
            charset = part.get_content_charset() or "utf-8"
            try:
                text = payload.decode(charset, errors="replace")
            except (LookupError, UnicodeDecodeError):
                text = payload.decode("utf-8", errors="replace")

        if content_type == "text/plain":
            text_parts.append(text)
        elif content_type == "text/html":
            clean = re.sub(r"<[^>]+>", " ", text)
            clean = re.sub(r"&nbsp;", " ", clean)
            clean = re.sub(r"&amp;", "&", clean)
            clean = re.sub(r"&lt;", "<", clean)
            clean = re.sub(r"&gt;", ">", clean)
            clean = re.sub(r"\s{2,}", " ", clean)
            text_parts.append(clean.strip())

    walk(msg)
    out = "\n\n".join(filter(None, text_parts))
    if _looks_like_markup(out):
        out = _strip_html_to_text(out)
    return out


def _extract_text_from_bytes(raw_bytes: bytes) -> str:
    """Parse raw bytes as an email message and extract text."""
    msg = message_from_bytes(raw_bytes, policy=email.policy.compat32)
    return _extract_text_from_message(msg)


def fetch_target_email() -> Optional[dict]:
    """
    Connect to Gmail, find the target email, and return a dict with all
    .eml attachments (or message/rfc822 parts) and their extracted text.
    """
    logger.info("Connecting to IMAP %s:%s as %s", settings.IMAP_SERVER, settings.IMAP_PORT, settings.EMAIL_USER)
    mail = imaplib.IMAP4_SSL(settings.IMAP_SERVER, settings.IMAP_PORT)
    mail.login(settings.EMAIL_USER, settings.EMAIL_PASSWORD)
    mail.select("INBOX")

    # Search ALL emails from the sender (read + unread)
    search_criteria = f'(FROM "{settings.FILTER_SENDER}")'
    _, uids = mail.search(None, search_criteria)
    logger.info("IMAP search '%s' returned %d UIDs", search_criteria,
                len(uids[0].split()) if uids and uids[0] else 0)

    if not uids or not uids[0]:
        mail.logout()
        return None

    uid_list = uids[0].split()
    logger.info("Found %d emails from sender. Searching for subject match…", len(uid_list))

    target_msg: Optional[email.message.Message] = None
    target_meta: dict = {}

    for uid in reversed(uid_list):
        _, msg_data = mail.fetch(uid, "(RFC822)")
        if not msg_data or not msg_data[0]:
            continue

        raw_email = msg_data[0][1]
        msg = message_from_bytes(raw_email)
        subject = _decode_header_value(msg.get("Subject", ""))

        logger.debug("  Checking UID %s — subject: %s", uid.decode(), subject[:80])

        if settings.TARGET_SUBJECT.lower() not in subject.lower():
            continue

        logger.info("  ✓ Subject match found — UID %s: %s", uid.decode(), subject)
        target_msg = msg
        target_meta = {
            "message_id": msg.get("Message-ID", uid.decode()),
            "subject": subject,
            "sender": _decode_header_value(msg.get("From", "")),
            "date": msg.get("Date", ""),
        }
        break

    mail.logout()

    if target_msg is None:
        logger.warning("No email found matching subject: %s", settings.TARGET_SUBJECT)
        return None

    # ── Enumerate MIME parts (per-part detail only at DEBUG) ────────────────
    all_parts = list(target_msg.walk())
    logger.info("MIME walk: %d parts in matched email (per-part detail at DEBUG)", len(all_parts))
    for i, part in enumerate(all_parts):
        ct = part.get_content_type()
        disp = part.get("Content-Disposition", "—")
        fn = part.get_filename()
        payload_type = type(part.get_payload()).__name__
        logger.debug(
            "  Part %02d | type=%-30s | disp=%-20s | filename=%s | payload_type=%s",
            i, ct, str(disp)[:20], fn or "—", payload_type
        )

    # ── Extract attachments ─────────────────────────────────────────────────
    attachments: list[dict] = []
    used_filenames: set[str] = set()

    for i, part in enumerate(all_parts):
        content_type = part.get_content_type()
        declared = _declared_filename(part)

        # Nested forwarded mail (Gmail forwards) — often no filename on the part.
        is_nested_message = content_type in ("message/rfc822", "message/delivery-status")
        # True .eml attachment: MIME declares a name ending in .eml (not a synthetic label).
        has_eml_declared_name = bool(declared) and declared.lower().endswith(".eml")

        if not (is_nested_message or has_eml_declared_name):
            continue

        # Placeholder only for nested messages without a declared name (Subject-based rename later).
        filename = declared if declared else f"attachment_{i:03d}.eml"

        logger.debug(
            "  → Found attachment-like part %02d: type=%s declared=%s",
            i, content_type, declared or "(none)",
        )

        # Extract raw bytes
        raw_bytes: Optional[bytes] = None

        if content_type == "message/rfc822":
            inner_msg = _get_inner_message_any(part)
            if inner_msg is not None:
                raw_text = _extract_text_from_message(inner_msg)
            else:
                raw = part.get_payload(decode=True)
                if isinstance(raw, bytes) and raw.strip():
                    try:
                        raw_text = _extract_text_from_bytes(raw)
                    except Exception:
                        raw_text = ""
                else:
                    raw_text = ""
        else:
            # Regular .eml attachment: payload is the raw bytes
            raw_bytes = part.get_payload(decode=True)
            if raw_bytes is None:
                payload_str = part.get_payload()
                if isinstance(payload_str, str):
                    raw_bytes = payload_str.encode("utf-8", errors="replace")
            raw_text = _extract_text_from_bytes(raw_bytes) if raw_bytes else ""

        filename = _maybe_better_filename(filename, content_type, part, raw_bytes, raw_text)
        filename = _unique_filename(filename, used_filenames)

        if raw_text.strip():
            if _looks_like_markup(raw_text):
                raw_text = _strip_html_to_text(raw_text)
            logger.info("    Extracted %d chars from '%s'", len(raw_text), filename)
            attachments.append({"filename": filename, "raw_text": raw_text})
        else:
            logger.debug("    Part %02d produced empty text — skipping", i)

    logger.info("Total usable attachments found: %d", len(attachments))
    return {**target_meta, "attachments": attachments}
