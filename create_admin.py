#!/usr/bin/env python3
"""
create_admin.py — bootstrap a PLATFORM_ADMIN account from the CLI.

The platform deliberately has NO public endpoint that can mint an admin
(and ``POST /auth/users`` requires an existing admin), so the very first
administrator enters through this operator-run script. It connects with
the app's own async engine and the platform-realm RLS session, exactly
like the application would.

Usage (from the project root, .env supplies the DB config):

    python3 create_admin.py                                   # defaults
    python3 create_admin.py --email ceo@hotel.mn --password 'S3cure-Pass!'
    python3 create_admin.py --full-name "Бат Дорж"

Idempotent: if a user with the email already exists, the script reports
it and exits 0 without touching the row (it will NOT reset a password —
that would make a typo'd rerun a silent account takeover).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# This machine may expose another project's `app` package via PYTHONPATH —
# make absolutely sure we import THIS project first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import get_engine, platform_session  # noqa: E402
from app.core.passwords import hash_password  # noqa: E402
from app.models.domain import User, UserRole  # noqa: E402

DEFAULT_EMAIL = "admin@hotel.mn"
DEFAULT_PASSWORD = "Admin123!"  # noqa: S105 — documented local-dev default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bootstrap a PLATFORM_ADMIN user (idempotent).",
    )
    parser.add_argument("--email", default=DEFAULT_EMAIL,
                        help=f"admin email (default: {DEFAULT_EMAIL})")
    parser.add_argument("--password", default=DEFAULT_PASSWORD,
                        help="admin password (default: the documented dev one)")
    parser.add_argument("--full-name", default="Platform Administrator",
                        help='display name (default: "Platform Administrator")')
    return parser.parse_args()


async def create_admin(email: str, password: str, full_name: str) -> int:
    """Returns a process exit code (0 = success or already exists)."""
    email = email.strip().lower()
    if "@" not in email or len(email) < 6:
        print(f"✖ {email!r} does not look like an email address")
        return 1
    if len(password) < 8:
        print("✖ password must be at least 8 characters (login enforces this)")
        return 1
    if len(password) < 10:
        print("⚠ password is shorter than the 10-char provisioning policy — "
              "fine for local dev, change it for anything shared")

    try:
        async with platform_session() as session:
            existing = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if existing is not None:
                role = existing.role.value
                print(f"• {email} already exists (role={role}) — nothing to do.")
                print("  Passwords are never reset by this script; use a new "
                      "email or update it through the API.")
                return 0

            user = User(
                email=email,
                hashed_password=hash_password(password),
                full_name=full_name,
                role=UserRole.PLATFORM_ADMIN,
                # PLATFORM_ADMIN carries no tenant/restaurant scope — the
                # role_realm_consistency check constraint enforces this too.
                tenant_id=None,
                restaurant_id=None,
            )
            session.add(user)
            try:
                await session.flush()
            except IntegrityError:
                # Lost a race with a concurrent run — same outcome, still ok.
                print(f"• {email} was created concurrently — nothing to do.")
                return 0
            user_id = user.id
    finally:
        await get_engine().dispose()  # clean pool shutdown, no exit warnings

    print(f"✔ PLATFORM_ADMIN created: {email} (id={user_id})")
    print(f"  database: {settings.POSTGRES_DB} @ "
          f"{settings.POSTGRES_HOST}:{settings.POSTGRES_PORT}")
    print(f"  login:    POST {settings.API_V1_PREFIX}/auth/login")
    return 0


def main() -> None:
    args = parse_args()
    exit_code = asyncio.run(
        create_admin(args.email, args.password, args.full_name)
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
