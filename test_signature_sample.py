"""
Console test: run signature email/phone extraction on up to 5 .eml payloads.

Usage (backend/.env must have NVIDIA_* and, for Gmail, EMAIL_* / IMAP_* / FILTER_SENDER / TARGET_SUBJECT):

  python test_signature_sample.py
      → 1) any *.eml in cwd, then repo root
      → 2) if none: fetch the matching inbox email from Gmail and use up to 5 attachments
         (the 5 largest bodies by character count — more likely to include signatures)

  python test_signature_sample.py path/to/file.eml [more.eml ...]
  python test_signature_sample.py path/to/folder_with_eml
"""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent / "backend"
REPO_ROOT = Path(__file__).resolve().parent
MAX_FILES = 5


def _bootstrap_imports() -> None:
    sys.path.insert(0, str(BACKEND))
    from dotenv import load_dotenv  # noqa: E402

    load_dotenv(BACKEND / ".env")


def _load_eml_text(path: Path) -> str:
    raw = path.read_bytes()
    from imap_client import _extract_text_from_bytes  # noqa: E402

    return _extract_text_from_bytes(raw)


def _collect_eml_paths(args: list[str]) -> list[Path]:
    """Resolve up to MAX_FILES .eml paths from args, or auto-discover locally."""
    paths: list[Path] = []
    seen: set[str] = set()

    def add(p: Path) -> bool:
        if not p.is_file():
            return False
        key = str(p.resolve())
        if key in seen:
            return False
        seen.add(key)
        paths.append(p)
        return len(paths) >= MAX_FILES

    if args:
        for a in args:
            p = Path(a)
            if p.is_dir():
                for f in sorted(p.glob("*.eml")):
                    if add(f):
                        return paths
            else:
                if add(p):
                    return paths
        return paths

    for root in (Path.cwd(), REPO_ROOT):
        for f in sorted(root.glob("*.eml")):
            if add(f):
                return paths
    return paths


async def _run_one_text(label: str, text: str) -> None:
    from agents.signature_extract import (  # noqa: E402
        preprocess_for_signature,
        llm_extract_signature_chunk,
        _merge_unique_emails,
        _merge_unique_phones,
    )

    chunk = preprocess_for_signature(text)
    print(f"\n=== {label} ===")
    print(f"raw chars: {len(text)} | signature chunk chars: {len(chunk)}")
    result = await llm_extract_signature_chunk(chunk)
    emails = _merge_unique_emails([result.get("emails") or ""])
    phones = _merge_unique_phones([result.get("phones") or ""])
    print("emails:", emails or "(none)")
    print("phones:", phones or "(none)")


async def _run_one_file(path: Path) -> None:
    text = _load_eml_text(path)
    await _run_one_text(path.name, text)


async def main() -> None:
    args = [a for a in sys.argv[1:] if a]
    paths = _collect_eml_paths(args)

    _bootstrap_imports()

    if args:
        if not paths:
            print("No matching .eml files for the paths you gave.")
            sys.exit(1)
        print(f"Processing {len(paths)} local .eml file(s) (max {MAX_FILES}):")
        for p in paths:
            print(f"  - {p}")
        for p in paths:
            await _run_one_file(p)
        return

    # No CLI args: local first, then Gmail
    if paths:
        print(f"Processing {len(paths)} local .eml file(s) (max {MAX_FILES}):")
        for p in paths:
            print(f"  - {p}")
        for p in paths:
            await _run_one_file(p)
        return

    print("No local *.eml in cwd or repo root — fetching from Gmail (same rules as the app)…")
    from imap_client import fetch_target_email  # noqa: E402

    # Keep console quiet even if root logging is DEBUG (e.g. backend defaults)
    logging.getLogger("imap_client").setLevel(logging.WARNING)

    email_data = await asyncio.to_thread(fetch_target_email)
    if not email_data:
        print("IMAP: no email matched FILTER_SENDER + TARGET_SUBJECT, or inbox empty.")
        sys.exit(1)

    attachments = email_data.get("attachments") or []
    if not attachments:
        print("IMAP: matched email has no usable .eml / rfc822 parts with text.")
        sys.exit(1)

    nonempty = [a for a in attachments if (a.get("raw_text") or "").strip()]
    nonempty.sort(
        key=lambda a: len(a.get("raw_text") or ""),
        reverse=True,
    )
    batch = nonempty[:MAX_FILES]
    print(f"Using {len(batch)} attachment(s) from: {email_data.get('subject', '')[:70]!r}")
    for att in batch:
        name = att.get("filename") or "(unnamed)"
        raw = att.get("raw_text") or ""
        await _run_one_text(name, raw)


if __name__ == "__main__":
    asyncio.run(main())
