"""
IMAP client: connects to the broker mailbox, fetches every incoming email
(skipping automated/notification senders), and extracts the body text plus
any real file attachments (images / PDF / Excel / Word) for each one.

Each broker email is returned as its own record — the pipeline then treats
one email = one position source = one card in "Vessel Extracted Data".
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
from email_text import html_to_plain_text, strip_plain_strikethrough

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
            text_parts.append(strip_plain_strikethrough(text))
        elif content_type == "text/html":
            clean = html_to_plain_text(text)
            if clean:
                text_parts.append(clean)

    walk(msg)
    return "\n\n".join(filter(None, text_parts))


def _extract_text_from_bytes(raw_bytes: bytes) -> str:
    """Parse raw bytes as an email message and extract text."""
    msg = message_from_bytes(raw_bytes, policy=email.policy.compat32)
    return _extract_text_from_message(msg)


def _extract_html_from_message(msg: email.message.Message) -> str:
    """Return the richest text/html body of the message (for a formatted preview)."""
    html_parts: list[str] = []

    def walk(part: email.message.Message) -> None:
        if part.is_multipart():
            for sub in part.get_payload():
                walk(sub)
            return
        if part.get_content_type() != "text/html":
            return
        disp = str(part.get("Content-Disposition", "")).lower()
        if "attachment" in disp:
            return
        payload = part.get_payload(decode=True)
        if not payload:
            return
        charset = part.get_content_charset() or "utf-8"
        try:
            html_parts.append(payload.decode(charset, errors="replace"))
        except (LookupError, UnicodeDecodeError):
            html_parts.append(payload.decode("utf-8", errors="replace"))

    walk(msg)
    # Prefer the longest HTML body (usually the full message rather than a stub).
    return max(html_parts, key=len) if html_parts else ""


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


def is_blocked_sender(from_header: str) -> bool:
    """True if the From header matches any automated/notification pattern."""
    hay = (from_header or "").lower()
    return any(pat in hay for pat in settings.blocked_sender_patterns)


def _subject_to_filename(subject: str, sender: str) -> str:
    """Human-friendly source label for the attachment/card."""
    base = (subject or "").strip() or (sender or "").strip() or "email"
    base = re.sub(r"\s+", " ", base)
    return base[:200]


def get_inbox_max_uid() -> int:
    """Highest IMAP UID currently in INBOX (0 if empty)."""
    mail = imaplib.IMAP4_SSL(settings.IMAP_SERVER, settings.IMAP_PORT)
    try:
        mail.login(settings.EMAIL_USER, settings.EMAIL_PASSWORD)
        typ, _ = mail.select("INBOX")
        if typ != "OK":
            return 0
        typ, data = mail.uid("search", None, "ALL")
        if typ != "OK" or not data or not data[0]:
            return 0
        uids = [int(x) for x in data[0].split() if x]
        return max(uids) if uids else 0
    finally:
        try:
            mail.logout()
        except Exception:  # noqa: BLE001
            pass


def fetch_broker_emails(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    min_uid: Optional[int] = None,
) -> list[dict]:
    """
    Connect to the mailbox, walk INBOX messages (optionally date-filtered),
    skip automated senders, and return one record per broker email:

        {
            "message_id": str,   # stable dedupe key
            "subject": str,
            "sender": str,       # full From header
            "date": str,         # RFC822 Date header
            "filename": str,     # display label (subject)
            "raw_text": str,     # body text (plain + stripped html)
            "files": [ {filename, content_type, content(bytes)}, ... ],
            "imap_uid": int,     # IMAP UID (for IDLE watermark)
        }

    Newest first. Dedupe / only-new filtering is handled downstream (ingestion).

    date_from / date_to: ISO dates YYYY-MM-DD (inclusive). Mapped to IMAP
    SINCE / BEFORE (BEFORE is exclusive, so date_to uses the next calendar day).

    min_uid: when set (IDLE auto-fetch), only return messages with IMAP UID
    strictly greater than this watermark — never backfill the whole inbox.
    """
    from datetime import date, datetime, timedelta

    def _parse_iso(raw: Optional[str]) -> Optional[date]:
        if not raw:
            return None
        try:
            return datetime.strptime(raw.strip()[:10], "%Y-%m-%d").date()
        except ValueError:
            logger.warning("Ignoring invalid fetch date: %r", raw)
            return None

    def _imap_day(d: date) -> str:
        # IMAP requires English month abbreviations regardless of locale.
        return d.strftime("%d-%b-%Y")

    df = _parse_iso(date_from)
    dt = _parse_iso(date_to)
    if df and dt and dt < df:
        df, dt = dt, df

    logger.info(
        "Connecting to IMAP %s:%s as %s (date_from=%s date_to=%s min_uid=%s)",
        settings.IMAP_SERVER,
        settings.IMAP_PORT,
        settings.EMAIL_USER,
        df.isoformat() if df else None,
        dt.isoformat() if dt else None,
        min_uid,
    )
    mail = imaplib.IMAP4_SSL(settings.IMAP_SERVER, settings.IMAP_PORT)
    mail.login(settings.EMAIL_USER, settings.EMAIL_PASSWORD)
    mail.select("INBOX")

    # Always UID SEARCH so IDLE watermarking is stable across deletes/restarts.
    if min_uid is not None:
        start = max(0, int(min_uid)) + 1
        logger.info("IMAP UID SEARCH UID %s:*", start)
        typ, uids = mail.uid("search", None, f"UID {start}:*")
        if typ != "OK":
            uids = [b""]
        raw_list = uids[0].split() if uids and uids[0] else []
        # Gmail quirk: UID N:* can still return the last message when N is past max.
        uid_list = [u for u in raw_list if int(u) >= start]
    elif df or dt:
        parts: list[str] = []
        if df:
            parts.append(f'SINCE "{_imap_day(df)}"')
        if dt:
            parts.append(f'BEFORE "{_imap_day(dt + timedelta(days=1))}"')
        criteria = "(" + " ".join(parts) + ")"
        logger.info("IMAP UID SEARCH %s", criteria)
        typ, uids = mail.uid("search", None, criteria)
        if typ != "OK":
            uids = [b""]
        uid_list = uids[0].split() if uids and uids[0] else []
    else:
        typ, uids = mail.uid("search", None, "ALL")
        if typ != "OK":
            uids = [b""]
        uid_list = uids[0].split() if uids and uids[0] else []

    logger.info("INBOX search returned %d messages", len(uid_list))

    emails: list[dict] = []
    skipped = 0

    for uid in reversed(uid_list):  # newest first
        uid_i = int(uid)
        # Cheap header peek first — decide blocklist without downloading body.
        _, hdr_data = mail.uid(
            "fetch",
            uid,
            "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
        )
        from_header = ""
        if hdr_data and hdr_data[0] and isinstance(hdr_data[0][1], (bytes, bytearray)):
            hdr_msg = message_from_bytes(bytes(hdr_data[0][1]))
            from_header = _decode_header_value(hdr_msg.get("From", ""))

        if from_header and is_blocked_sender(from_header):
            skipped += 1
            continue

        # Keeper → download the full message.
        _, msg_data = mail.uid("fetch", uid, "(RFC822)")
        if not msg_data or not msg_data[0]:
            continue
        raw_email = msg_data[0][1]
        msg = message_from_bytes(raw_email, policy=email.policy.compat32)

        sender = _decode_header_value(msg.get("From", "")) or from_header
        if is_blocked_sender(sender):  # double-check with full header
            skipped += 1
            continue

        subject = _decode_header_value(msg.get("Subject", ""))
        message_id = msg.get("Message-ID") or f"uid-{uid_i}"
        raw_text = _extract_text_from_message(msg)
        html_body = _extract_html_from_message(msg)
        files = _extract_files_from_message(msg)

        logger.info(
            "  ✓ Keeping '%s' from %s — uid=%s %d chars body, %d html, %d file(s)",
            subject[:60], sender[:40], uid_i, len(raw_text), len(html_body), len(files),
        )

        emails.append({
            "message_id": message_id,
            "subject": subject,
            "sender": sender,
            "date": msg.get("Date", ""),
            "filename": _subject_to_filename(subject, sender),
            "raw_text": raw_text,
            "html": html_body,
            "files": files,
            "imap_uid": uid_i,
        })

    mail.logout()
    logger.info("Fetch complete — %d broker email(s) kept, %d automated skipped",
                len(emails), skipped)
    return emails
