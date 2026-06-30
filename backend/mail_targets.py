"""
Hardcoded Gmail fetch profiles.

Each profile matches forwarded broker position-list emails. One Fetch click
processes every matching inbox message not yet stored (newest first).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class MailTarget:
    name: str
    sender: str
    subject_contains: str


# Forwarded vessel open-position digests in the inbox.
MAIL_TARGETS: tuple[MailTarget, ...] = (
    MailTarget(
        name="tarun_vessel_open_positions",
        sender="info@icontech.sg",
        subject_contains="Vessel Open Positions List",
    ),
    MailTarget(
        name="sanjib_vessel_open_positions",
        sender="sanjib@iconshipbrokers.com",
        subject_contains="Sample of vessel's open positions from vessel owners",
    ),
)
