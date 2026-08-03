"""police column minimisation: revoke table SELECT, add fixed projections

Revision ID: b8d2ea53c621
Revises: a7c1d9e42b10
Create Date: 2026-08-03 00:00:00.000000+00:00

Security finding (audit 2026-08-03): ``police_runtime`` held table-level
``SELECT`` on ``bookings``, ``tenants`` and ``rooms``. PostgreSQL RLS filters
rows, not columns, so the police realm could read ``guest_phone``,
``guest_email``, ``pin_code`` (the zero-trust arrival PIN), ``total_amount``,
``escrow_status``, ``commission_rate`` and every other booking column —
contradicting the documented claim that the realms meet only through the
registry hash. Proven before the fix by selecting those columns as the real
``police_runtime`` role.

This revision revokes the direct grants and replaces them with two fixed
SECURITY DEFINER projections:

* ``police_screening_candidate(booking_id)`` — runs for EVERY check-in and
  returns only ``booking_id``, ``tenant_id`` and ``guest_registry_hash``.
  No name, no contact details, no money, no PIN.
* ``police_match_dispatch(match_id, status, limit)`` — dispatch details
  (guest name, room, hotel address/coords) driven FROM ``police_matches``, so
  a guest who never matched the watchlist is never projected at all.

Both are owned by the NOLOGIN ``rls_exempt`` role, use a fixed
``search_path`` with fully-qualified object names, contain no dynamic SQL,
have ``EXECUTE`` revoked from ``PUBLIC`` and granted only to
``police_runtime``, and additionally guard on ``app_realm() = 'police'``.

Safe on populated databases: privilege/function changes only, no data touched.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "b8d2ea53c621"
down_revision: Union[str, None] = "a7c1d9e42b10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_exempt') THEN
            CREATE ROLE rls_exempt NOLOGIN BYPASSRLS;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
            CREATE ROLE police_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
          END IF;
        END
        $$;

        GRANT SELECT ON bookings, tenants, rooms TO rls_exempt;

        -- (1) Screening: correlation minimum, zero PII.
        DROP FUNCTION IF EXISTS police_screening_candidate(uuid);
        CREATE FUNCTION police_screening_candidate(p_booking_id uuid)
        RETURNS TABLE (
          booking_id          uuid,
          tenant_id           uuid,
          guest_registry_hash text
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public AS $fn$
          SELECT b.id, b.tenant_id, b.guest_registry_hash
          FROM public.bookings b
          WHERE b.id = p_booking_id
            AND public.app_realm() = 'police'
        $fn$;
        ALTER FUNCTION police_screening_candidate(uuid) OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION police_screening_candidate(uuid) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION police_screening_candidate(uuid)
          TO police_runtime;

        -- (2) Dispatch: only for recorded matches.
        DROP FUNCTION IF EXISTS police_match_dispatch(uuid, text, int);
        CREATE FUNCTION police_match_dispatch(
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
          LIMIT GREATEST(COALESCE(p_limit, 100), 0)
        $fn$;
        ALTER FUNCTION police_match_dispatch(uuid, text, int) OWNER TO rls_exempt;
        REVOKE ALL ON FUNCTION police_match_dispatch(uuid, text, int) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION police_match_dispatch(uuid, text, int)
          TO police_runtime;

        -- Only now that the projections exist: close the wide door.
        REVOKE ALL ON bookings, tenants, rooms FROM police_runtime;
        """
    )


def downgrade() -> None:
    """
    Restores the PRE-AUDIT posture: direct table SELECT for the police realm.

    Provided for reversibility only — running it re-exposes guest contact
    details, arrival PINs and escrow state to the police realm.
    """
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
            GRANT SELECT ON bookings, tenants, rooms TO police_runtime;
          END IF;
        END
        $$;
        DROP FUNCTION IF EXISTS police_match_dispatch(uuid, text, int);
        DROP FUNCTION IF EXISTS police_screening_candidate(uuid);
        """
    )
