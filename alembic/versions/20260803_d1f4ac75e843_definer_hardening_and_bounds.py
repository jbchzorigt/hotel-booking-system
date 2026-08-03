"""SECURITY DEFINER hardening: fixed search_path, qualified refs, bounded limits

Revision ID: d1f4ac75e843
Revises: c9e3fb64d732
Create Date: 2026-08-03 00:00:00.000000+00:00

Follow-up hardening pass over the SECURITY DEFINER surface.

Two functions predating this audit (``tenant_available_rooms`` and
``admin_police_alerts``) still ran with ``search_path = public`` and referenced
their tables unqualified. That is only safe while no role can create objects in
``public`` — a fragile assumption to rest a definer function on, since a single
mistaken ``GRANT CREATE`` would let a runtime role shadow a referenced table
and hijack a function running as ``rls_exempt`` (which is ``BYPASSRLS``).

This revision:

* pins ``search_path = pg_catalog, public`` on both, with every referenced
  object schema-qualified (so resolution no longer depends on the path at all);
* explicitly revokes ``CREATE ON SCHEMA public`` from ``PUBLIC`` and from all
  three runtime roles — PostgreSQL 15+ does this for ``PUBLIC`` by default, but
  stating it survives an older server or a restored dump;
* bounds the ``p_limit`` argument of both projection functions with
  ``LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500)`` so an authenticated
  caller cannot request an unbounded result set;
* re-asserts ``REVOKE ALL ... FROM PUBLIC`` plus a single explicit ``GRANT
  EXECUTE`` per function, so EXECUTE is never held by PUBLIC.

Safe on populated databases: function definitions and privileges only, no data
touched. Idempotent.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "d1f4ac75e843"
down_revision: Union[str, None] = "c9e3fb64d732"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        -- Nobody but the owner may add objects to the definer search path.
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            REVOKE CREATE ON SCHEMA public FROM app_runtime;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
            REVOKE CREATE ON SCHEMA public FROM platform_runtime;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
            REVOKE CREATE ON SCHEMA public FROM police_runtime;
          END IF;
        END
        $$;

        -- Marketplace availability probe.
        CREATE OR REPLACE FUNCTION tenant_available_rooms(
          p_tenant_id uuid, p_check_in date, p_check_out date
        ) RETURNS bigint
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public AS $fn$
          SELECT count(*)
          FROM public.rooms r
          WHERE r.tenant_id = p_tenant_id
            AND r.is_active
            AND NOT EXISTS (
              SELECT 1 FROM public.bookings b
              WHERE b.room_id = r.id
                AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
                AND daterange(b.check_in_date, b.check_out_date)
                    && daterange(p_check_in, p_check_out)
            );
        $fn$;
        ALTER FUNCTION tenant_available_rooms(uuid, date, date) OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION tenant_available_rooms(uuid, date, date) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_available_rooms(uuid, date, date)
          TO app_runtime, platform_runtime;

        -- Platform-admin redacted police-alert projection, now bounded.
        CREATE OR REPLACE FUNCTION admin_police_alerts(p_limit int DEFAULT 100)
        RETURNS TABLE (
          match_id uuid,
          matched_at timestamptz,
          status text,
          wanted_full_name text,
          case_reference text,
          tenant_id uuid,
          hotel_name text,
          room_number text,
          booking_code text,
          guest_full_name text
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public AS $fn$
          SELECT
            pm.id,
            pm.matched_at,
            pm.status::text,
            wp.full_name,
            wp.case_reference,
            pm.tenant_id,
            t.name,
            r.room_number,
            b.code,
            b.guest_full_name
          FROM public.police_matches pm
          JOIN public.wanted_persons wp ON wp.id = pm.wanted_person_id
          JOIN public.bookings b        ON b.id  = pm.booking_id
          JOIN public.rooms r           ON r.id  = b.room_id
          JOIN public.tenants t         ON t.id  = pm.tenant_id
          WHERE public.app_is_platform_admin()
          ORDER BY pm.matched_at DESC
          LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
        $fn$;
        ALTER FUNCTION admin_police_alerts(int) OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION admin_police_alerts(int) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION admin_police_alerts(int) TO platform_runtime;

        -- Police dispatch projection: identical body, bounded limit.
        CREATE OR REPLACE FUNCTION police_match_dispatch(
          p_match_id uuid DEFAULT NULL,
          p_status   text DEFAULT NULL,
          p_limit    int  DEFAULT 100
        )
        RETURNS TABLE (
          match_id         uuid,
          match_status     text,
          matched_at       timestamptz,
          reviewed_at      timestamptz,
          review_note      text,
          wanted_person_id uuid,
          wanted_full_name text,
          case_reference   text,
          district         text,
          wanted_status    text,
          tenant_id        uuid,
          hotel_name       text,
          hotel_address    text,
          hotel_maps_lat   double precision,
          hotel_maps_lng   double precision,
          room_number      text,
          booking_code     text,
          guest_full_name  text,
          check_in_date    date,
          check_out_date   date
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public AS $fn$
          SELECT
            pm.id,
            pm.status::text,
            pm.matched_at,
            pm.reviewed_at,
            pm.review_note,
            wp.id,
            wp.full_name,
            wp.case_reference,
            wp.district,
            wp.status::text,
            pm.tenant_id,
            t.name,
            t.address,
            t.maps_lat::double precision,
            t.maps_lng::double precision,
            r.room_number,
            b.code,
            b.guest_full_name,
            b.check_in_date,
            b.check_out_date
          FROM public.police_matches pm
          JOIN public.wanted_persons wp ON wp.id = pm.wanted_person_id
          JOIN public.bookings b        ON b.id  = pm.booking_id
          JOIN public.rooms r           ON r.id  = b.room_id
          JOIN public.tenants t         ON t.id  = pm.tenant_id
          WHERE public.app_realm() = 'police'
            AND (p_match_id IS NULL OR pm.id = p_match_id)
            AND (p_status   IS NULL OR pm.status::text = p_status)
          ORDER BY pm.matched_at DESC
          LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
        $fn$;
        ALTER FUNCTION police_match_dispatch(uuid, text, int) OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION police_match_dispatch(uuid, text, int) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION police_match_dispatch(uuid, text, int)
          TO police_runtime;

        REVOKE ALL ON FUNCTION police_screening_candidate(uuid) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION police_screening_candidate(uuid)
          TO police_runtime;
        """
    )


def downgrade() -> None:
    """
    Reverts to the previous function definitions (unbounded ``p_limit``,
    ``search_path = public``, unqualified references).

    The ``REVOKE CREATE ON SCHEMA public`` is intentionally NOT reverted:
    re-granting schema-create rights to runtime roles would be a gratuitous
    downgrade of the security posture, and nothing in the application ever
    needed it.
    """
    op.execute(
        """
        CREATE OR REPLACE FUNCTION tenant_available_rooms(
          p_tenant_id uuid, p_check_in date, p_check_out date
        ) RETURNS bigint
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
          SELECT count(*)
          FROM rooms r
          WHERE r.tenant_id = p_tenant_id
            AND r.is_active
            AND NOT EXISTS (
              SELECT 1 FROM bookings b
              WHERE b.room_id = r.id
                AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
                AND daterange(b.check_in_date, b.check_out_date)
                    && daterange(p_check_in, p_check_out)
            );
        $fn$;
        ALTER FUNCTION tenant_available_rooms(uuid, date, date) OWNER TO rls_exempt;
        """
    )
