#!/usr/bin/env python3
"""
create_police_officer.py — bootstrap a police officer account from the CLI.

The police realm has its own identity store (``police_officers``) with no
public creation endpoint, so the first officer enters through this
operator-run script. It connects with the police-realm session
(``police_session()``, realm='police') — the only identity allowed to
write that table.

Usage (from the project root; .env supplies DB config):

    python3 create_police_officer.py                                  # defaults
    python3 create_police_officer.py --badge P-1001 --password 'S3cure!!' \
        --full-name "Батбаяр" --rank "Ахлах дэслэгч"

Idempotent: an existing badge number reports and exits 0 without touching
the row (it will NOT reset a password).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# Guard against another project's `app` package on PYTHONPATH.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.core.database import get_police_engine, police_session  # noqa: E402
from app.core.passwords import hash_password  # noqa: E402
from app.models.domain import PoliceOfficer  # noqa: E402

DEFAULT_BADGE = "P-1000"
DEFAULT_PASSWORD = "Police123!"  # noqa: S105 — documented local-dev default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bootstrap a police officer (idempotent).",
    )
    parser.add_argument("--badge", default=DEFAULT_BADGE,
                        help=f"badge number (default: {DEFAULT_BADGE})")
    parser.add_argument("--password", default=DEFAULT_PASSWORD,
                        help="password (default: the documented dev one)")
    parser.add_argument("--full-name", default="Duty Officer",
                        help='display name (default: "Duty Officer")')
    parser.add_argument("--rank", default=None, help="optional rank")
    return parser.parse_args()


async def create_officer(
    badge: str, password: str, full_name: str, rank: str | None
) -> int:
    badge = badge.strip()
    if len(password) < 8:
        print("✖ password must be at least 8 characters (login enforces this)")
        return 1

    try:
        async with police_session() as session:
            existing = (
                await session.execute(
                    select(PoliceOfficer).where(
                        PoliceOfficer.badge_number == badge
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                print(f"• officer {badge} already exists — nothing to do.")
                return 0

            officer = PoliceOfficer(
                badge_number=badge,
                hashed_password=hash_password(password),
                full_name=full_name,
                rank=rank,
            )
            session.add(officer)
            try:
                await session.flush()
            except IntegrityError:
                print(f"• officer {badge} was created concurrently — ok.")
                return 0
            officer_id = officer.id
    finally:
        await get_police_engine().dispose()

    print(f"✔ police officer created: {badge} (id={officer_id})")
    print("  login: POST /api/v1/police/login  {badge_number, password}")
    return 0


def main() -> None:
    args = parse_args()
    sys.exit(
        asyncio.run(
            create_officer(args.badge, args.password, args.full_name, args.rank)
        )
    )


if __name__ == "__main__":
    main()
