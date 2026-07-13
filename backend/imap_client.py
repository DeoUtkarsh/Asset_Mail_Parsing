"""
IMAP client: connects to Gmail, finds the target email, and extracts
raw text from every .eml attachment (or message/rfc822 part).
"""
import imaplib
import email
import email.policy
import re
import logging
from email import message_from_bytes
from email.header import decode_header
from typing import Optional

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
            return

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
    return "\n\n".join(filter(None, text_parts))


def _extract_text_from_bytes(raw_bytes: bytes) -> str:
    """Parse raw bytes as an email message and extract text."""
    msg = message_from_bytes(raw_bytes, policy=email.policy.compat32)
    return _extract_text_from_message(msg)


def _extract_files_from_message(msg: email.message.Message) -> list[dict]:
    """Return real file attachments of an email: [{filename, content_type, content(bytes)}]."""
    files: list[dict] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disp = str(part.get("Content-Disposition", "")).lower()
        fn_raw = part.get_filename()
        # Skip the message bodies; keep anything that is a named/attached file
        is_body = ctype in ("text/plain", "text/html") and "attachment" not in disp
        if is_body:
            continue
        if not fn_raw and "attachment" not in disp and "inline" not in disp:
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        filename = _decode_header_value(fn_raw) if fn_raw else f"file_{len(files) + 1}.{ctype.split('/')[-1]}"
        files.append({"filename": filename, "content_type": ctype, "content": payload})
    return files


def _headers_of(msg: email.message.Message) -> dict:
    return {
        "mail_from": _decode_header_value(msg.get("From", "")),
        "mail_subject": _decode_header_value(msg.get("Subject", "")),
        "mail_date": msg.get("Date", ""),
    }


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

    # ── Enumerate ALL MIME parts for debugging ──────────────────────────────
    logger.info("Enumerating all MIME parts in the matched email:")
    all_parts = list(target_msg.walk())
    for i, part in enumerate(all_parts):
        ct = part.get_content_type()
        disp = part.get("Content-Disposition", "—")
        fn = part.get_filename()
        payload_type = type(part.get_payload()).__name__
        logger.info(
            "  Part %02d | type=%-30s | disp=%-20s | filename=%s | payload_type=%s",
            i, ct, str(disp)[:20], fn or "—", payload_type
        )

    # ── Extract attachments ─────────────────────────────────────────────────
    attachments: list[dict] = []

    for i, part in enumerate(all_parts):
        content_type = part.get_content_type()
        filename_raw = part.get_filename()
        filename = _decode_header_value(filename_raw) if filename_raw else ""
        disp = str(part.get("Content-Disposition", "")).lower()

        is_eml_by_name = filename.lower().endswith(".eml")
        is_eml_by_type = content_type in ("message/rfc822", "message/delivery-status")
        is_attachment = "attachment" in disp or "inline" in disp

        if not (is_eml_by_name or is_eml_by_type):
            continue

        logger.info("  → Found attachment-like part %02d: type=%s filename=%s", i, content_type, filename or "(no name)")

        # Parse the .eml into an inner Message so we can pull headers + its files
        inner_msg: Optional[email.message.Message] = None

        if content_type == "message/rfc822":
            inner = part.get_payload()
            if isinstance(inner, list) and inner:
                inner = inner[0]
            if isinstance(inner, email.message.Message):
                inner_msg = inner
            elif isinstance(inner, bytes):
                inner_msg = message_from_bytes(inner, policy=email.policy.compat32)
        else:
            raw_bytes = part.get_payload(decode=True)
            if raw_bytes is None:
                payload_str = part.get_payload()
                if isinstance(payload_str, str):
                    raw_bytes = payload_str.encode("utf-8", errors="replace")
            if raw_bytes:
                inner_msg = message_from_bytes(raw_bytes, policy=email.policy.compat32)

        if inner_msg is not None:
            raw_text = _extract_text_from_message(inner_msg)
            headers = _headers_of(inner_msg)
            files = _extract_files_from_message(inner_msg)
        else:
            raw_text = str(part.get_payload())
            headers = {"mail_from": "", "mail_subject": "", "mail_date": ""}
            files = []

        if not filename:
            filename = f"attachment_{i:03d}.eml"

        logger.info(
            "    Extracted %d chars of text + %d file(s) from '%s' (from=%s)",
            len(raw_text), len(files), filename, headers.get("mail_from", "")[:40]
        )

        if raw_text.strip() or files:
            attachments.append({"filename": filename, "raw_text": raw_text, "files": files, **headers})
        else:
            logger.warning("    Part %02d produced empty text — skipping", i)

    logger.info("Total usable attachments found: %d", len(attachments))
    return {**target_meta, "attachments": attachments}
