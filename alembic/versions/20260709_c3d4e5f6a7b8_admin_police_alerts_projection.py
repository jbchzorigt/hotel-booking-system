"""admin redacted police-alerts projection (SECURITY DEFINER function)

Revision ID: c3d4e5f6a7b8
Revises: af80fbe033ec
Create Date: 2026-07-09 00:00:00.000000+00:00

Adds the ``admin_police_alerts`` SECURITY DEFINER function plus the
``rls_exempt`` grants it needs, by re-running the idempotent
``scripts/enable_rls.sql`` (same convention as the RLS + contact_requests
revisions). No new table: platform admins read the EXISTING police_matches
through a redacted, metadata-only projection — the raw registry number is
never stored and never exposed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "af80fbe033ec"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_RLS_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "enable_rls.sql"


def upgrade() -> None:
    sql = _RLS_SCRIPT.read_text(encoding="utf-8")
    # Alembic owns the transaction; strip the script's own BEGIN/COMMIT.
    sql = sql.replace("\nBEGIN;\n", "\n").replace("\nCOMMIT;\n", "\n")
    op.get_bind().exec_driver_sql(sql)


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS admin_police_alerts(int)")
