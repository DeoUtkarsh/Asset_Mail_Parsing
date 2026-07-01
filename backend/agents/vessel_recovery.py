"""
Shared vessel recovery without LLM — used by live extraction fallback.
"""
from __future__ import annotations

import logging
from typing import Any

from agents.vertical_tonnage import parse_vertical_tonnage_vessels
from agents.structured_parsers import (
    filter_trusted_rule_vessels,
    is_image_only_attachment,
    parse_with_rules,
    rules_result_trusted,
)
from agents.eta_foc import enrich_vessels_eta_foc

logger = logging.getLogger(__name__)


def _rule_parser_vessels(filename: str, raw_text: str) -> list[dict[str, Any]]:
    ruled = parse_with_rules(filename, raw_text)
    if not ruled:
        return []
    if rules_result_trusted(ruled):
        return ruled
    trusted = filter_trusted_rule_vessels(ruled)
    return trusted if trusted else []


def recover_vessels_without_llm(
    filename: str,
    raw_text: str,
) -> tuple[list[dict[str, Any]], str]:
    """
    Try vertical tonnage then broker/prose rule parsers.
    Returns (vessels, source) where source is vertical|rules|none.
    """
    fallback = parse_vertical_tonnage_vessels(raw_text)
    if fallback:
        return enrich_vessels_eta_foc(raw_text, fallback), "vertical"

    ruled = _rule_parser_vessels(filename, raw_text)
    if ruled:
        return enrich_vessels_eta_foc(raw_text, ruled), "rules"

    return enrich_vessels_eta_foc(raw_text, []), "none"


def is_skippable_image_only(filename: str, raw_text: str) -> bool:
    """True for screenshot/PDF-only mails — excluded from migration."""
    return is_image_only_attachment(raw_text, filename)


def apply_extraction_fallback(
    raw_text: str,
    filename: str,
    llm_vessels: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str]:
    """Keep LLM rows when present; otherwise run rule recovery."""
    if llm_vessels:
        return enrich_vessels_eta_foc(raw_text, llm_vessels), "llm"
    recovered, source = recover_vessels_without_llm(filename, raw_text)
    return recovered, source
