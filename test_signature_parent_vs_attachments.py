#!/usr/bin/env python3
"""
Compare per-attachment signature columns vs naive hints from each file’s text tail.

Usage (repo root, venv on):
  python test_signature_parent_vs_attachments.py
  python test_signature_parent_vs_attachments.py --llm
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"

_EMAIL_RX = re.compile(
    r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b",
    re.I,
)
_PHONE_RX = re.compile(
    r"(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,6}\b",
)


def _tail(text: str, n: int = 3500) -> str:
    if not text:
        return ""
    t = text.strip()
    return t[-n:] if len(t) > n else t


def _naive_contacts(tail: str) -> tuple[list[str], list[str]]:
    emails = sorted(set(_EMAIL_RX.findall(tail)))
    phones = sorted(set(p.strip() for p in _PHONE_RX.findall(tail) if len(re.sub(r"\D", "", p)) >= 8))
    return emails[:20], phones[:20]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm", action="store_true")
    args = parser.parse_args()

    if not BACKEND.is_dir():
        print("ERROR: backend/ not found.", file=sys.stderr)
        sys.exit(1)
    os.chdir(BACKEND)
    sys.path.insert(0, str(BACKEND))

    from database import supabase

    parents = (
        supabase.table("parent_emails")
        .select("id, subject, date_received")
        .order("date_received", desc=True)
        .limit(1)
        .execute()
    )
    if not parents.data:
        print("No parent_emails rows.")
        sys.exit(0)
    pid = parents.data[0]["id"]

    print("=" * 72)
    print("SIGNATURE — stored per attachment (attachments.signature_*)")
    print("=" * 72)
    print(f"Latest parent: {pid}")
    print(f"Subject: {parents.data[0].get('subject', '')[:100]}")
    print()

    atts = (
        supabase.table("attachments")
        .select("id, filename, raw_text, signature_emails, signature_phones")
        .eq("parent_email_id", pid)
        .order("created_at", desc=False)
        .execute()
    )
    rows = atts.data or []
    print(f"Attachments: {len(rows)}")
    print("=" * 72)

    for i, att in enumerate(rows, 1):
        fn = att.get("filename") or "(no name)"
        raw = att.get("raw_text") or ""
        em, ph = _naive_contacts(_tail(raw, 4000))
        print(f"\n[{i}] {fn}")
        print(f"    DB signature_emails: {att.get('signature_emails') or '(null)'}")
        print(f"    DB signature_phones: {att.get('signature_phones') or '(null)'}")
        print(f"    naive emails in tail: {em[:6]}{' ...' if len(em) > 6 else ''}")
        print(f"    naive phones in tail: {ph[:6]}{' ...' if len(ph) > 6 else ''}")

    if args.llm:
        print("\n" + "=" * 72)
        print("--llm: LLM per attachment")
        print("=" * 72)

        async def run_llm() -> None:
            from agents.signature_extract import llm_extract_signature_chunk, preprocess_for_signature

            for i, att in enumerate(rows, 1):
                fn = att.get("filename") or "(no name)"
                raw = att.get("raw_text") or ""
                chunk = preprocess_for_signature(raw)
                if len(chunk) < 30:
                    print(f"\n[{i}] {fn} — skip (short chunk)")
                    continue
                r = await llm_extract_signature_chunk(chunk)
                print(f"\n[{i}] {fn}")
                print(f"    LLM emails: {r.get('emails') or '(empty)'}")
                print(f"    LLM phones: {r.get('phones') or '(empty)'}")
                await asyncio.sleep(0.15)

        asyncio.run(run_llm())

    print("\n" + "=" * 72)
    print("Grid column signature_emails / signature_phones come from vessels_full →")
    print("attachments (same attachment_id as the vessel row).")
    print("=" * 72)


if __name__ == "__main__":
    main()
