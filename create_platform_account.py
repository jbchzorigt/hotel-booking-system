#!/usr/bin/env python3
"""
create_platform_account.py — seed the singleton platform wallet row.

``platform_accounts`` holds exactly one row (enforced by the
``uq_platform_accounts_singleton`` unique index): the platform's own MNT
wallet, whose balance is the running total of the append-only
``platform_ledger_entries``. Escrow settlement locks and credits it, and the
admin revenue dashboard reads it.

Without this row a fresh install looks healthy until the first platform
operation, then fails: ``GET /admin/dashboard/revenue`` raises
``NoResultFound`` (500) and ``EscrowService`` raises
``PlatformAccountMissingError("seed the PlatformAccount row before
settling")``. This script closes that bootstrap gap, alongside
``create_admin.py`` and ``create_police_officer.py``.

It runs in the platform-realm session, so it connects as
``platform_runtime`` — the only role with write access to the wallet.

Usage (from the project root, .env supplies the DB config):

    python3 create_platform_account.py
    python3 create_platform_account.py --commission-rate 0.05

Idempotent: if the row already exists, it reports the current balance and
exits 0 without modifying it. It will NEVER overwrite a live balance —
that is ledger-derived money.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from decimal import Decimal

# This machine may expose another project's `app` package via PYTHONPATH —
# make absolutely sure we import THIS project first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.dialects.postgresql import insert as pg_insert  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import get_platform_engine, platform_session  # noqa: E402
from app.models.domain import PlatformAccount  # noqa: E402


async def ensure_platform_account(
    *, currency: str, commission_rate: Decimal
) -> tuple[bool, PlatformAccount]:
    """
    Idempotently guarantee the singleton platform wallet exists.

    Returns ``(created_by_this_call, account)``.

    Implemented as a single ``INSERT ... ON CONFLICT DO NOTHING RETURNING``
    against the ``uq_platform_accounts_singleton`` index — NOT
    select-then-insert. Two reasons:

    * **Transaction safety.** A constraint violation aborts the PostgreSQL
      transaction; catching the resulting ``IntegrityError`` does not make it
      committable, and the enclosing ``session.begin()`` would then raise
      ``PendingRollbackError`` while trying to COMMIT during teardown.
      ``ON CONFLICT DO NOTHING`` never raises, so the transaction stays clean
      and commits normally on either path.
    * **Correctness under concurrency.** Select-then-insert has a race window
      between the check and the write. The upsert is atomic: of two concurrent
      runs, exactly one inserts and the other is a no-op. (For an
      uncommitted conflicting row PostgreSQL makes the second statement wait
      for the first transaction to finish, so the follow-up SELECT below —
      a new statement, hence a new READ COMMITTED snapshot — always observes
      the winner's row.)

    The balance is only ever supplied on INSERT. On the conflict path nothing
    is written, so a live, ledger-derived balance can never be reset by
    re-running this.
    """
    async with platform_session() as session:
        inserted_id = (
            await session.execute(
                pg_insert(PlatformAccount)
                .values(
                    currency=currency,
                    balance=Decimal("0.00"),
                    commission_rate=commission_rate,
                )
                .on_conflict_do_nothing()
                .returning(PlatformAccount.id)
            )
        ).scalar_one_or_none()

        # One read serves both paths: the row we just wrote, or the one that
        # already existed / was written concurrently.
        account = (
            await session.execute(select(PlatformAccount).limit(1))
        ).scalar_one()

    return inserted_id is not None, account


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed the singleton platform wallet (idempotent).",
    )
    parser.add_argument(
        "--commission-rate",
        default="0.0500",
        help=(
            "Fallback commission rate stored on the account (default 0.0500). "
            "Per-tenant rates on Tenant.platform_fee_percent override it at "
            "booking time; this is only the platform-wide default."
        ),
    )
    parser.add_argument(
        "--currency", default=settings.PLATFORM_CURRENCY,
        help="ISO currency code (default from PLATFORM_CURRENCY).",
    )
    return parser.parse_args()


async def main() -> int:
    args = parse_args()

    try:
        rate = Decimal(args.commission_rate)
    except Exception:
        print(f"✖ {args.commission_rate!r} is not a valid decimal")
        return 1
    if not (Decimal("0") <= rate < Decimal("1")):
        print("✖ commission rate must be a fraction in [0, 1) — e.g. 0.05 for 5%")
        return 1

    try:
        created, account = await ensure_platform_account(
            currency=args.currency, commission_rate=rate
        )
    finally:
        await get_platform_engine().dispose()

    if created:
        print(f"✔ platform account created (id={account.id})")
        print(f"  currency: {account.currency}  "
              f"default commission: {account.commission_rate}")
    else:
        # Either it predated this run or a concurrent run won the race — the
        # outcome is identical and equally successful, so exit 0 either way.
        print(
            f"• platform account already present (id={account.id}, "
            f"balance={account.balance} {account.currency}) — nothing to do."
        )
        print("  Balances are ledger-derived and are never reset here.")
    print(f"  database: {settings.POSTGRES_DB} @ "
          f"{settings.POSTGRES_HOST}:{settings.POSTGRES_PORT}")
    print(f"  connected as: {settings.POSTGRES_PLATFORM_USER}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
