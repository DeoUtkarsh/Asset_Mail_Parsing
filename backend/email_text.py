"""
Email body text helpers — strip strikethrough/crossed-out content before extraction.
"""
from __future__ import annotations

import re

_STRIKE_TAGS = ("s", "strike", "del")


def strip_strikethrough_html(html: str) -> str:
    """Remove HTML elements that render as crossed-out text (and their content)."""
    if not html:
        return ""
    text = html
    for tag in _STRIKE_TAGS:
        text = re.sub(
            rf"<{tag}\b[^>]*>.*?</{tag}>",
            " ",
            text,
            flags=re.IGNORECASE | re.DOTALL,
        )
    # <span style="... line-through ...">...</span> and similar
    text = re.sub(
        r"<([a-zA-Z][\w:-]*)\b[^>]*\bstyle\s*=\s*['\"][^'\"]*line-through[^'\"]*['\"][^>]*>.*?</\1>",
        " ",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Outlook / Word often use <span style="text-decoration:line-through">
    text = re.sub(
        r"<span\b[^>]*text-decoration\s*:\s*line-through[^>]*>.*?</span>",
        " ",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return text


def html_to_plain_text(html: str) -> str:
    """Convert HTML to plain text after removing strikethrough blocks."""
    clean = strip_strikethrough_html(html)
    clean = re.sub(r"<br\s*/?>", "\n", clean, flags=re.IGNORECASE)
    clean = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<[^>]+>", " ", clean)
    clean = re.sub(r"&nbsp;", " ", clean)
    clean = re.sub(r"&amp;", "&", clean)
    clean = re.sub(r"&lt;", "<", clean)
    clean = re.sub(r"&gt;", ">", clean)
    clean = re.sub(r"[ \t\r\f\v]+", " ", clean)
    clean = re.sub(r"\n{3,}", "\n\n", clean)
    return clean.strip()


def strip_plain_strikethrough(text: str) -> str:
    """Remove ~~markdown-style~~ strikethrough segments from plain text."""
    if not text:
        return ""
    cleaned = re.sub(r"~~.+?~~", " ", text, flags=re.DOTALL)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def prepare_extraction_text(raw_text: str, preview_html: str | None = None) -> str:
    """
    Build the body text sent to the extraction LLM.
    Prefer HTML (strikethrough removed) when available; fall back to plain text cleanup.
    """
    if preview_html and preview_html.strip():
        from_html = html_to_plain_text(preview_html)
        if from_html.strip():
            return from_html[:12000]
    base = raw_text or ""
    return strip_plain_strikethrough(base)[:12000]
