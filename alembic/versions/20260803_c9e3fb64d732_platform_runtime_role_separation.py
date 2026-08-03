"""platform_runtime: bind platform privilege to a DB login role, not a GUC

Revision ID: c9e3fb64d732
Revises: b8d2ea53c621
Create Date: 2026-08-03 00:00:00.000000+00:00

Security finding (audit 2026-08-03): ``app_is_platform_admin()`` tested only
``app.user_role``, a session GUC. Any ``app_runtime`` connection could execute
``SET LOCAL app.user_role = 'PLATFORM_ADMIN'`` and gain cross-tenant
visibility — proven before the fix: a tenant-scoped session saw 0 bookings,
then 18 (all tenants) plus the platform wallet after one statement. A second
GUC would NOT fix this: the same attacker sets both. The boundary has to be
something the session cannot assert about itself.

The fix is a DISTINCT LOGIN ROLE, ``platform_runtime``. ``app_is_platform_
admin()`` now additionally requires ``session_user = 'platform_runtime'``:

* ``session_user`` is the authenticated login role. It is NOT changed by
  ``SET ROLE`` and NOT changed by ``SECURITY DEFINER`` context switches, so
  existing definer functions keep working for platform callers.
* No runtime role is a member of another (memberships revoked below), so
  ``SET ROLE platform_runtime`` fails for ``app_runtime``.

What this DOES defend against: SQL injection inside a tenant request, and a
leaked ``app_runtime`` password.
What it does NOT defend against: compromise of the application host, which can
read every DSN from its own environment. That remains an open deployment-level
finding — see BACKEND_README "Security boundaries".

Secret provisioning is deliberately OUT of scope here: this revision creates
the role with the local placeholder password only if the role does not already
exist, and NEVER overwrites an existing role's password. Production
credentials are injected out of band (``ALTER ROLE platform_runtime PASSWORD
...``) and configured via ``POSTGRES_PLATFORM_PASSWORD``, which the
application's fail-fast guard requires to differ from ``POSTGRES_PASSWORD``.

Safe on populated databases: role/grant/function changes only, no data touched.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "c9e3fb64d732"
down_revision: Union[str, None] = "b8d2ea53c621"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
            -- Local placeholder ONLY; rotate out of band before production.
            CREATE ROLE platform_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
          END IF;
        END
        $$;

        -- No runtime role may assume another (blocks SET ROLE escalation).
        REVOKE platform_runtime FROM app_runtime, police_runtime;
        REVOKE app_runtime      FROM platform_runtime, police_runtime;
        REVOKE police_runtime   FROM app_runtime, platform_runtime;

        GRANT USAGE ON SCHEMA public TO platform_runtime;

        -- Cross-tenant business tables.
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          tenants, users, rooms, minibar_categories, minibar_items,
          minibar_consumptions, bookings, restaurants, food_items,
          food_orders, food_order_items
        TO platform_runtime;

        -- Wallet is mutable current-state; ledger is append-only history.
        GRANT SELECT, INSERT, UPDATE ON platform_accounts TO platform_runtime;
        GRANT SELECT, INSERT ON platform_ledger_entries TO platform_runtime;
        REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries
          FROM platform_runtime;
        REVOKE ALL ON wanted_persons, police_matches FROM platform_runtime;

        DO $$
        BEGIN
          IF to_regclass('public.contact_requests') IS NOT NULL THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON contact_requests
              TO platform_runtime;
            REVOKE ALL ON contact_requests FROM app_runtime;
          END IF;
        END
        $$;

        -- The tenant role loses the platform surface entirely.
        REVOKE ALL ON platform_accounts, platform_ledger_entries
          FROM app_runtime;

        -- Definer functions follow their callers.
        GRANT EXECUTE ON FUNCTION tenant_available_rooms(uuid, date, date)
          TO app_runtime, platform_runtime;
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_proc WHERE proname = 'admin_police_alerts'
          ) THEN
            GRANT EXECUTE ON FUNCTION admin_police_alerts(int)
              TO platform_runtime;
            REVOKE EXECUTE ON FUNCTION admin_police_alerts(int) FROM app_runtime;
          END IF;
        END
        $$;

        -- The predicate itself: login role AND role GUC.
        CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
        LANGUAGE sql STABLE AS $fn$
          SELECT session_user = 'platform_runtime'
             AND app_user_role() = 'PLATFORM_ADMIN'
        $fn$;
        """
    )


def downgrade() -> None:
    """
    Restores the PRE-AUDIT predicate (GUC-only platform privilege) and returns
    the platform surface to ``app_runtime``.

    Reversible for schema purposes; running it re-opens the self-elevation
    finding. The ``platform_runtime`` role is intentionally NOT dropped —
    dropping a login role that may own objects or hold active sessions is
    unsafe on a populated database, and leaving it in place is harmless once
    the predicate no longer references it.
    """
    op.execute(
        """
        CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
        LANGUAGE sql STABLE AS $fn$
          SELECT app_user_role() = 'PLATFORM_ADMIN'
        $fn$;

        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            GRANT SELECT, INSERT, UPDATE ON platform_accounts TO app_runtime;
            GRANT SELECT, INSERT ON platform_ledger_entries TO app_runtime;
            IF to_regclass('public.contact_requests') IS NOT NULL THEN
              GRANT SELECT, INSERT, UPDATE, DELETE ON contact_requests
                TO app_runtime;
            END IF;
            IF EXISTS (
              SELECT 1 FROM pg_proc WHERE proname = 'admin_police_alerts'
            ) THEN
              GRANT EXECUTE ON FUNCTION admin_police_alerts(int) TO app_runtime;
            END IF;
          END IF;
        END
        $$;
        """
    )
