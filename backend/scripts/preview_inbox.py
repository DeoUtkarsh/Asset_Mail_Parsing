"""
Read-only IMAP preview — sanity check before running a real fetch.

Logs into the broker mailbox, lists every INBOX message, and shows which ones
would be KEPT (parsed) vs SKIPPED (automated senders), and which kept ones are
NEW vs already in the database. Downloads headers only — no bodies, no LLM.

Run from the backend directory:
    ..\\venv\\Scripts\\python.exe scripts\\preview_inbox.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import imaplib
from email import message_from_bytes

from config import settings
from imap_client import _decode_header_value, is_blocked_sender


def _seen_message_ids() -> set[str]:
    try:
        from database import supabase
        rows = supabase.table("parent_emails").select("message_id").execute().data or []
        return {r.get("message_id") for r in rows if r.get("message_id")}
    except Exception as exc:  # noqa: BLE001
        print(f"  (could not read DB message ids: {exc})")
        return set()


def main() -> None:
    print(f"Connecting to {settings.IMAP_SERVER} as {settings.EMAIL_USER} …")
    mail = imaplib.IMAP4_SSL(settings.IMAP_SERVER, settings.IMAP_PORT)
    mail.login(settings.EMAIL_USER, settings.EMAIL_PASSWORD)
    mail.select("INBOX")

    _, uids = mail.search(None, "ALL")
    uid_list = uids[0].split() if uids and uids[0] else []
    print(f"INBOX messages: {len(uid_list)}")
    print(f"Blocklist: {', '.join(settings.blocked_sender_patterns)}\n")

    seen = _seen_message_ids()
    kept = skipped = new = 0

    print(f"{'STATE':<12} {'NEW?':<6} FROM  —  SUBJECT")
    print("-" * 90)
    for uid in reversed(uid_list):
        _, data = mail.fetch(
            uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])"
        )
        if not data or not data[0] or not isinstance(data[0][1], (bytes, bytearray)):
            continue
        msg = message_from_bytes(bytes(data[0][1]))
        frm = _decode_header_value(msg.get("From", ""))
        subj = _decode_header_value(msg.get("Subject", ""))
        mid = msg.get("Message-ID") or ""

        if is_blocked_sender(frm):
            skipped += 1
            print(f"{'SKIP':<12} {'-':<6} {frm[:34]:<34}  {subj[:40]}")
        else:
            kept += 1
            is_new = mid not in seen
            new += int(is_new)
            print(f"{'KEEP':<12} {('YES' if is_new else 'seen'):<6} {frm[:34]:<34}  {subj[:40]}")

    mail.logout()
    print("-" * 90)
    print(f"KEEP={kept}  (NEW to process={new}, already in DB={kept - new})   SKIP={skipped}")


if __name__ == "__main__":
    main()
