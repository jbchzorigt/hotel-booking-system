"""ledger append-only: revoke mutation privileges + immutability triggers

Revision ID: a7c1d9e42b10
Revises: 4b4454c4abd6
Create Date: 2026-08-03 00:00:00.000000+00:00

Security finding (audit 2026-08-03): ``platform_ledger_entries`` was
documented as "append-only and authoritative", but ``app_runtime`` held
``UPDATE``/``DELETE`` and the ``platform_only`` policy was ``FOR ALL`` — so a
session holding the PLATFORM_ADMIN GUC could rewrite or erase financial
history. Proven before the fix with ``UPDATE 1`` / ``DELETE 1``.

Three independent locks are installed here:

1. **Privileges** — ``UPDATE``, ``DELETE`` and ``TRUNCATE`` revoked from every
   runtime role.
2. **Policies** — the ``FOR ALL`` policy is replaced by a ``FOR SELECT`` and a
   ``FOR INSERT`` policy, so no policy exists that could admit a mutation even
   if a privilege were re-granted by mistake.
3. **Triggers** — ``ledger_is_append_only()`` raises on UPDATE/DELETE (row
   level) and TRUNCATE (statement level). The function is owned by the NOLOGIN
   ``rls_exempt`` role, so runtime roles cannot ``CREATE OR REPLACE`` it, alter
   it, or drop/disable the triggers (all of which require ownership).

Corrections, refunds and chargebacks are posted as NEW compensating entries.

Safe on populated databases: privilege and policy changes only, no table
rewrite, no data touched. Idempotent.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "a7c1d9e42b10"
down_revision: Union[str, None] = "4b4454c4abd6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        -- The NOLOGIN owner for immutability objects. Created here so this
        -- revision stands alone on databases predating the RLS refresh.
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_exempt') THEN
            CREATE ROLE rls_exempt NOLOGIN BYPASSRLS;
          END IF;
        END
        $$;

        -- 1. Privileges: nobody mutates ledger history.
        REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries
          FROM PUBLIC;
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries
              FROM app_runtime;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
            REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries
              FROM platform_runtime;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
            REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries
              FROM police_runtime;
          END IF;
        END
        $$;

        -- 2. Policies: SELECT + INSERT only. No policy can admit a mutation.
        DROP POLICY IF EXISTS platform_only ON platform_ledger_entries;
        DROP POLICY IF EXISTS ledger_read   ON platform_ledger_entries;
        CREATE POLICY ledger_read ON platform_ledger_entries
          FOR SELECT USING (app_is_platform_admin());
        DROP POLICY IF EXISTS ledger_append ON platform_ledger_entries;
        CREATE POLICY ledger_append ON platform_ledger_entries
          FOR INSERT WITH CHECK (app_is_platform_admin());

        -- 3. Triggers, owned by rls_exempt so runtime roles cannot touch them.
        CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION USING
            MESSAGE = 'platform_ledger_entries is append-only: ' || TG_OP
                      || ' denied. Post a compensating entry instead of '
                      || 'rewriting history.',
            ERRCODE = 'insufficient_privilege';
        END
        $fn$;
        ALTER FUNCTION ledger_is_append_only() OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION ledger_is_append_only() FROM PUBLIC;

        DROP TRIGGER IF EXISTS ledger_no_mutation ON platform_ledger_entries;
        CREATE TRIGGER ledger_no_mutation
          BEFORE UPDATE OR DELETE ON platform_ledger_entries
          FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

        DROP TRIGGER IF EXISTS ledger_no_truncate ON platform_ledger_entries;
        CREATE TRIGGER ledger_no_truncate
          BEFORE TRUNCATE ON platform_ledger_entries
          FOR EACH STATEMENT EXECUTE FUNCTION ledger_is_append_only();
        """
    )


def downgrade() -> None:
    """
    Restores the PRE-AUDIT (mutable) ledger posture.

    Provided for schema reversibility only. Running it re-opens the finding
    this revision closed — financial history becomes rewritable again. It does
    not restore any data, because nothing was destroyed on upgrade.
    """
    op.execute(
        """
        DROP TRIGGER IF EXISTS ledger_no_truncate ON platform_ledger_entries;
        DROP TRIGGER IF EXISTS ledger_no_mutation ON platform_ledger_entries;
        DROP FUNCTION IF EXISTS ledger_is_append_only();

        DROP POLICY IF EXISTS ledger_read   ON platform_ledger_entries;
        DROP POLICY IF EXISTS ledger_append ON platform_ledger_entries;
        DROP POLICY IF EXISTS platform_only ON platform_ledger_entries;
        CREATE POLICY platform_only ON platform_ledger_entries
          FOR ALL
          USING      (app_is_platform_admin())
          WITH CHECK (app_is_platform_admin());

        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON platform_ledger_entries
              TO app_runtime;
          END IF;
        END
        $$;
        """
    )
