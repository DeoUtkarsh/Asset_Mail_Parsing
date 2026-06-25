"""
Hardcoded Gmail fetch profiles.

Each profile matches forwarded broker position-list emails. Fetch picks the
newest inbox message matching any profile whose Message-ID is not already in DB.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class MailTarget:
    name: str
    sender: str
    subject_contains: str


# Tarun Agarwal forwards vessel open-position digests to the inbox.
MAIL_TARGETS: tuple[MailTarget, ...] = (
    MailTarget(
        name="tarun_vessel_open_positions",
        sender="info@icontech.sg",
        subject_contains="Vessel Open Positions List",
    ),
)
