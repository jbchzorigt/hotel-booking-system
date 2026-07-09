"""enable row-level security, realms, grants and helper functions

Revision ID: a1b2c3d4e5f6
Revises: 35d2dfee301a
Create Date: 2026-07-08 00:00:00.000000+00:00

Executes ``scripts/enable_rls.sql`` — the single source of truth for the
platform's security posture (runtime roles, grants, RLS policies for the
hotel/restaurant/platform/police/marketplace realms, and the BYPASSRLS
availability function). The script is idempotent by construction
(DROP POLICY IF EXISTS / CREATE OR REPLACE / conditional role creation),
so re-running it is always safe.

When policies change: edit the script, then add a new revision whose
upgrade() is exactly this one — the schema history then records WHEN each
security posture went live.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "35d2dfee301a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_RLS_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "enable_rls.sql"


def upgrade() -> None:
    sql = _RLS_SCRIPT.read_text(encoding="utf-8")
    # Alembic manages the transaction; strip the script's own BEGIN/COMMIT
    # so we don't end the migration transaction prematurely.
    sql = sql.replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n")
    op.get_bind().exec_driver_sql(sql)


def downgrade() -> None:
    # Policies/roles are left in place on downgrade: disabling RLS on a
    # database that still holds multi-tenant data is never the safe
    # direction. Drop the database or write an explicit teardown if a
    # true reversal is required.
    pass
