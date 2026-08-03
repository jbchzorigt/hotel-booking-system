-- ===========================================================================
-- Row-Level Security for the Hotel Booking Marketplace
-- ===========================================================================
-- Run AFTER the schema exists (Alembic migration or Base.metadata.create_all),
-- as a superuser / schema owner. Idempotent: safe to re-run.
--
-- Trust model
-- -----------
-- The application connects with the low-privilege role `app_runtime`
-- (NOT the table owner, NEVER a superuser — both would bypass RLS unless
-- FORCE is set; we set FORCE anyway, defense in depth). Per request, the
-- FastAPI dependency that opens a DB session executes:
--
--     SET LOCAL app.user_role     = '<UserRole of the JWT principal>';
--     SET LOCAL app.tenant_id     = '<uuid or empty>';
--     SET LOCAL app.restaurant_id = '<uuid or empty>';
--     SET LOCAL app.realm         = 'app';        -- 'police' only for the
--                                                 -- police service role
--
-- `SET LOCAL` scopes the values to the current transaction, so pooled
-- connections (asyncpg + pgbouncer transaction pooling) cannot leak one
-- request's identity into the next.
--
-- Default posture: table with RLS enabled and no matching policy = DENY ALL.
-- ===========================================================================

BEGIN;

-- Needed by the bookings anti-double-booking GiST exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 0. Database roles
-- ---------------------------------------------------------------------------
-- Role separation is a SECURITY BOUNDARY, not bookkeeping. The passwords
-- below are placeholders for local development ONLY: secret provisioning is
-- deliberately NOT done here (see docs/deployment notes) so a migration never
-- carries a production credential. Rotate with ALTER ROLE ... PASSWORD out of
-- band; this script never overwrites an existing role's password.
DO $$
BEGIN
  -- Tenant runtime: the ordinary hotel/restaurant/guest request path.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
  -- Platform runtime: cross-tenant workflows (escrow, reconciliation, admin
  -- reporting). A DISTINCT login role, because `app.user_role` is a GUC any
  -- app_runtime session can set for itself — see app_is_platform_admin().
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
    CREATE ROLE platform_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
  -- Police matcher/API.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
    CREATE ROLE police_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
  -- NOLOGIN owner for SECURITY DEFINER functions and immutability triggers.
  -- Nobody can log in as it, and no runtime role is a member, so runtime
  -- roles can never replace, alter or drop what it owns.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_exempt') THEN
    CREATE ROLE rls_exempt NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- No runtime role may assume another: without membership, `SET ROLE` fails,
-- so privilege separation cannot be undone from inside a session.
REVOKE platform_runtime FROM app_runtime, police_runtime;
REVOKE app_runtime      FROM platform_runtime, police_runtime;
REVOKE police_runtime   FROM app_runtime, platform_runtime;

GRANT USAGE ON SCHEMA public TO app_runtime, platform_runtime, police_runtime;
-- USAGE only, never CREATE: a runtime role that could create objects in the
-- schema on the SECURITY DEFINER search_path could shadow a referenced object
-- and hijack a definer function. (PostgreSQL 15+ already revokes CREATE from
-- PUBLIC by default; stated explicitly so it survives an older server or a
-- restored dump.)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app_runtime, platform_runtime, police_runtime;

-- App realm (TENANT scope): CRUD on business tables. NOTHING on police
-- tables and NOTHING on the platform wallet/ledger — those now belong to
-- platform_runtime alone.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, rooms, minibar_categories, minibar_items,
  minibar_consumptions, bookings, restaurants, food_items,
  food_orders, food_order_items
TO app_runtime;
REVOKE ALL ON wanted_persons, police_matches FROM app_runtime;
REVOKE ALL ON platform_accounts, platform_ledger_entries FROM app_runtime;

-- Platform realm: the same business tables (cross-tenant), the wallet, and
-- APPEND-ONLY access to the ledger. Note the deliberate absence of UPDATE
-- and DELETE on platform_ledger_entries — financial history is immutable;
-- corrections are new compensating entries.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, rooms, minibar_categories, minibar_items,
  minibar_consumptions, bookings, restaurants, food_items,
  food_orders, food_order_items
TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON platform_accounts TO platform_runtime;
GRANT SELECT, INSERT           ON platform_ledger_entries TO platform_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON platform_ledger_entries FROM platform_runtime;
REVOKE ALL ON wanted_persons, police_matches FROM platform_runtime;

-- Police realm: its OWN tables only. Business data (bookings/tenants/rooms)
-- is reachable exclusively through the fixed SECURITY DEFINER projections in
-- section 6b — table-level SELECT would expose every column, because RLS
-- filters rows, not columns.
GRANT SELECT, INSERT, UPDATE ON wanted_persons, police_matches TO police_runtime;
REVOKE ALL ON bookings, tenants, rooms FROM police_runtime;
REVOKE ALL ON users, minibar_categories, minibar_items, restaurants,
  food_items, food_orders, food_order_items,
  platform_accounts, platform_ledger_entries
FROM police_runtime;

-- ---------------------------------------------------------------------------
-- 1. Session-context helper functions
-- ---------------------------------------------------------------------------
-- STABLE so the planner evaluates them once per statement, not per row.
-- current_setting(..., true) returns NULL instead of erroring when unset;
-- NULLIF guards against the empty string. Unset context therefore matches
-- no rows — fail closed.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_restaurant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.user_role', true), ''), 'ANONYMOUS')
$$;

-- Platform privilege requires BOTH:
--   (a) session_user = 'platform_runtime' — the DB LOGIN role. A tenant
--       connection cannot become this: it is not a member of the role, so
--       SET ROLE fails, and session_user is immune to SET ROLE and to
--       SECURITY DEFINER context switches anyway.
--   (b) app.user_role = 'PLATFORM_ADMIN' — scopes intent WITHIN the platform
--       connection. This half is settable by the session and is therefore
--       NOT a boundary on its own; it exists so platform code must opt in.
-- (a) is what makes SQL injection under app_runtime, or a leaked app_runtime
-- password, unable to reach cross-tenant data. It does NOT defend against a
-- compromised app host, which can read the platform DSN from its own env.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT session_user = 'platform_runtime'
     AND app_user_role() = 'PLATFORM_ADMIN'
$$;

CREATE OR REPLACE FUNCTION app_realm() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.realm', true), ''), 'app')
$$;

-- ---------------------------------------------------------------------------
-- 2. Enable + FORCE RLS on every protected table
-- ---------------------------------------------------------------------------
-- FORCE means even the table OWNER is subject to policies — protects against
-- accidentally running the app as the migration user.

ALTER TABLE tenants                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE rooms                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE minibar_categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE minibar_categories      FORCE  ROW LEVEL SECURITY;
ALTER TABLE minibar_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE minibar_items           FORCE  ROW LEVEL SECURITY;
ALTER TABLE minibar_consumptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE minibar_consumptions    FORCE  ROW LEVEL SECURITY;
ALTER TABLE bookings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings                FORCE  ROW LEVEL SECURITY;
ALTER TABLE restaurants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants             FORCE  ROW LEVEL SECURITY;
ALTER TABLE food_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_items              FORCE  ROW LEVEL SECURITY;
ALTER TABLE food_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_orders             FORCE  ROW LEVEL SECURITY;
ALTER TABLE food_order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_order_items        FORCE  ROW LEVEL SECURITY;
ALTER TABLE platform_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_accounts       FORCE  ROW LEVEL SECURITY;
ALTER TABLE platform_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_ledger_entries FORCE  ROW LEVEL SECURITY;
ALTER TABLE wanted_persons          ENABLE ROW LEVEL SECURITY;
ALTER TABLE wanted_persons          FORCE  ROW LEVEL SECURITY;
ALTER TABLE police_matches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE police_matches          FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Hotel realm — isolation by tenant_id
-- ---------------------------------------------------------------------------
-- FOR ALL + WITH CHECK: reads are filtered AND writes are constrained, so a
-- compromised session cannot INSERT/UPDATE rows into another tenant either.

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  FOR ALL
  USING       (app_is_platform_admin() OR id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  FOR ALL
  USING (
    app_is_platform_admin()
    OR tenant_id = app_tenant_id()
    -- restaurant owners may see accounts of their own restaurant
    OR restaurant_id = app_restaurant_id()
  )
  WITH CHECK (
    app_is_platform_admin()
    OR tenant_id = app_tenant_id()
    OR restaurant_id = app_restaurant_id()
  );

DROP POLICY IF EXISTS tenant_isolation ON rooms;
CREATE POLICY tenant_isolation ON rooms
  FOR ALL
  USING       (app_is_platform_admin() OR tenant_id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR tenant_id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON minibar_categories;
CREATE POLICY tenant_isolation ON minibar_categories
  FOR ALL
  USING       (app_is_platform_admin() OR tenant_id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR tenant_id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON minibar_items;
CREATE POLICY tenant_isolation ON minibar_items
  FOR ALL
  USING       (app_is_platform_admin() OR tenant_id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR tenant_id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON minibar_consumptions;
CREATE POLICY tenant_isolation ON minibar_consumptions
  FOR ALL
  USING       (app_is_platform_admin() OR tenant_id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR tenant_id = app_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON bookings;
CREATE POLICY tenant_isolation ON bookings
  FOR ALL
  USING       (app_is_platform_admin() OR tenant_id = app_tenant_id())
  WITH CHECK  (app_is_platform_admin() OR tenant_id = app_tenant_id());

-- Police matcher needs read access to booking hashes across all tenants.
DROP POLICY IF EXISTS police_read_bookings ON bookings;
CREATE POLICY police_read_bookings ON bookings
  FOR SELECT
  USING (app_realm() = 'police');

DROP POLICY IF EXISTS police_read_tenants ON tenants;
CREATE POLICY police_read_tenants ON tenants
  FOR SELECT
  USING (app_realm() = 'police');

-- Dispatch alerts include the room number.
DROP POLICY IF EXISTS police_read_rooms ON rooms;
CREATE POLICY police_read_rooms ON rooms
  FOR SELECT
  USING (app_realm() = 'police');

-- ---------------------------------------------------------------------------
-- 4. Restaurant realm — isolation by restaurant_id
-- ---------------------------------------------------------------------------
-- Restaurants sit in a hotel's vicinity, so hotel staff get read-only
-- visibility (discovery, inbound deliveries); only the owning restaurant
-- session (or platform admin) can write.

DROP POLICY IF EXISTS restaurant_read ON restaurants;
CREATE POLICY restaurant_read ON restaurants
  FOR SELECT
  USING (
    app_is_platform_admin()
    OR id = app_restaurant_id()          -- the owner
    OR tenant_id = app_tenant_id()       -- host hotel staff (read)
  );

-- Hotel managers register restaurants in their own vicinity; the platform
-- can register anywhere.
DROP POLICY IF EXISTS restaurant_write ON restaurants;
CREATE POLICY restaurant_write ON restaurants
  FOR INSERT
  WITH CHECK (app_is_platform_admin() OR tenant_id = app_tenant_id());
DROP POLICY IF EXISTS restaurant_update ON restaurants;
CREATE POLICY restaurant_update ON restaurants
  FOR UPDATE
  USING       (app_is_platform_admin() OR id = app_restaurant_id())
  WITH CHECK  (app_is_platform_admin() OR id = app_restaurant_id());
DROP POLICY IF EXISTS restaurant_delete ON restaurants;
CREATE POLICY restaurant_delete ON restaurants
  FOR DELETE USING (app_is_platform_admin());

DROP POLICY IF EXISTS restaurant_isolation ON food_items;
CREATE POLICY restaurant_isolation ON food_items
  FOR ALL
  USING       (app_is_platform_admin() OR restaurant_id = app_restaurant_id())
  WITH CHECK  (app_is_platform_admin() OR restaurant_id = app_restaurant_id());

-- Hotel guests browse menus through the hotel's session: read-only.
DROP POLICY IF EXISTS hotel_reads_menu ON food_items;
CREATE POLICY hotel_reads_menu ON food_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM restaurants r
      WHERE r.id = food_items.restaurant_id
        AND r.tenant_id = app_tenant_id()
        AND r.is_active
    )
  );

DROP POLICY IF EXISTS restaurant_isolation ON food_orders;
CREATE POLICY restaurant_isolation ON food_orders
  FOR ALL
  USING       (app_is_platform_admin() OR restaurant_id = app_restaurant_id())
  WITH CHECK  (app_is_platform_admin() OR restaurant_id = app_restaurant_id());

-- Reception sees (read-only) orders being delivered to their hotel.
DROP POLICY IF EXISTS hotel_reads_inbound_orders ON food_orders;
CREATE POLICY hotel_reads_inbound_orders ON food_orders
  FOR SELECT
  USING (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS restaurant_isolation ON food_order_items;
CREATE POLICY restaurant_isolation ON food_order_items
  FOR ALL
  USING       (app_is_platform_admin() OR restaurant_id = app_restaurant_id())
  WITH CHECK  (app_is_platform_admin() OR restaurant_id = app_restaurant_id());

DROP POLICY IF EXISTS hotel_reads_inbound_order_items ON food_order_items;
CREATE POLICY hotel_reads_inbound_order_items ON food_order_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM food_orders fo
      WHERE fo.id = food_order_items.food_order_id
        AND fo.tenant_id = app_tenant_id()
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Platform realm — PLATFORM_ADMIN only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS platform_only ON platform_accounts;
CREATE POLICY platform_only ON platform_accounts
  FOR ALL
  USING       (app_is_platform_admin())
  WITH CHECK  (app_is_platform_admin());

-- Ledger = append-only financial history. THREE independent locks:
--   1. privileges: no UPDATE/DELETE/TRUNCATE granted to any runtime role;
--   2. policies:   SELECT and INSERT only — there is no policy that could
--                  ever admit an UPDATE or DELETE, so even a future grant
--                  would still find no matching row;
--   3. a trigger (section 5b) that raises regardless of privileges.
-- Reversals, refunds and chargebacks are NEW compensating DEBIT entries.
DROP POLICY IF EXISTS platform_only ON platform_ledger_entries;
DROP POLICY IF EXISTS ledger_read ON platform_ledger_entries;
CREATE POLICY ledger_read ON platform_ledger_entries
  FOR SELECT USING (app_is_platform_admin());
DROP POLICY IF EXISTS ledger_append ON platform_ledger_entries;
CREATE POLICY ledger_append ON platform_ledger_entries
  FOR INSERT WITH CHECK (app_is_platform_admin());

-- ---------------------------------------------------------------------------
-- 5b. Ledger immutability trigger
-- ---------------------------------------------------------------------------
-- Defence in depth behind the privilege revocations: if a future migration
-- (or a mistaken GRANT) hands a runtime role UPDATE/DELETE, this still fires.
-- Owned by `rls_exempt`, a NOLOGIN role: runtime roles cannot CREATE OR
-- REPLACE it, ALTER it, or DROP the trigger, because they do not own the
-- function and are not superusers. Disabling a trigger requires table
-- ownership, which no runtime role has either.
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Built by concatenation, NOT a format placeholder: this script is also
  -- executed through drivers that treat the percent sign as a parameter
  -- marker, so the whole file must stay free of them.
  RAISE EXCEPTION USING
    MESSAGE = 'platform_ledger_entries is append-only: ' || TG_OP
              || ' denied. Post a compensating entry instead of rewriting '
              || 'history.',
    ERRCODE = 'insufficient_privilege';
END
$$;
ALTER FUNCTION ledger_is_append_only() OWNER TO rls_exempt;
REVOKE ALL ON FUNCTION ledger_is_append_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS ledger_no_mutation ON platform_ledger_entries;
CREATE TRIGGER ledger_no_mutation
  BEFORE UPDATE OR DELETE ON platform_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- TRUNCATE bypasses row triggers, so it gets its own statement-level guard.
DROP TRIGGER IF EXISTS ledger_no_truncate ON platform_ledger_entries;
CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON platform_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_is_append_only();

-- Onboarding leads: written by the platform-orchestrated public endpoint,
-- readable/managed ONLY by platform admins. No hotel, restaurant, police
-- or marketplace identity can even prove the table is non-empty.
-- Guarded: contact_requests arrives in a LATER revision than this script's
-- first run, so on fresh installs revision a1b2c3d4e5f6 must skip it; the
-- revision that creates the table re-runs this script and applies it.
DO $$
BEGIN
  IF to_regclass('public.contact_requests') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON contact_requests TO platform_runtime;
    REVOKE ALL ON contact_requests FROM app_runtime;
    ALTER TABLE contact_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contact_requests FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS platform_only ON contact_requests;
    CREATE POLICY platform_only ON contact_requests
      FOR ALL
      USING       (app_is_platform_admin())
      WITH CHECK  (app_is_platform_admin());
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Police realm — realm-gated; invisible to every app credential
-- ---------------------------------------------------------------------------
-- Two independent locks: (a) table privileges were never granted to
-- app_runtime, and (b) these policies only match when the session realm is
-- 'police'. An app session cannot even prove these tables are non-empty.

DROP POLICY IF EXISTS police_realm_only ON wanted_persons;
CREATE POLICY police_realm_only ON wanted_persons
  FOR ALL
  USING       (app_realm() = 'police')
  WITH CHECK  (app_realm() = 'police');

DROP POLICY IF EXISTS police_realm_only ON police_matches;
CREATE POLICY police_realm_only ON police_matches
  FOR ALL
  USING       (app_realm() = 'police')
  WITH CHECK  (app_realm() = 'police');

-- Police officer identity + audit log arrive in a LATER revision than this
-- script's first run, so guard on existence: the RLS revision (a1b2c3d4e5f6)
-- must skip them on a fresh install; the revision that CREATES the tables
-- re-runs this script and applies the block.
DO $$
BEGIN
  IF to_regclass('public.police_officers') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON police_officers TO police_runtime;
    REVOKE ALL ON police_officers FROM app_runtime;
    ALTER TABLE police_officers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE police_officers FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS police_realm_only ON police_officers;
    CREATE POLICY police_realm_only ON police_officers
      FOR ALL USING (app_realm() = 'police') WITH CHECK (app_realm() = 'police');
  END IF;

  IF to_regclass('public.police_audit_logs') IS NOT NULL THEN
    -- Append-only: INSERT + SELECT, never UPDATE/DELETE.
    GRANT SELECT, INSERT ON police_audit_logs TO police_runtime;
    REVOKE ALL ON police_audit_logs FROM app_runtime;
    ALTER TABLE police_audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE police_audit_logs FORCE  ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS police_realm_only ON police_audit_logs;
    CREATE POLICY police_realm_only ON police_audit_logs
      FOR ALL USING (app_realm() = 'police') WITH CHECK (app_realm() = 'police');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6b. Police projections — column-level minimisation
-- ---------------------------------------------------------------------------
-- RLS filters ROWS, not COLUMNS. Table-level SELECT on `bookings` therefore
-- exposed guest_phone, guest_email, pin_code, escrow/commission state and
-- every other column to the police realm — far beyond screening's need. The
-- direct grants are revoked in section 0; these two functions are the only
-- way in, and each returns a fixed, declared column list.
--
-- The split matters: screening runs for EVERY check-in, so it gets the
-- correlation minimum and no PII at all. Dispatch details (guest name, room,
-- hotel address) are keyed on `police_matches` — they exist only for a guest
-- who ACTUALLY matched the watchlist, never for the general booking
-- population.
--
-- Hardening applied to both: SECURITY DEFINER owned by the NOLOGIN
-- `rls_exempt` role, fixed `search_path` (pg_catalog first, no $user), fully
-- qualified object names, no dynamic SQL, EXECUTE revoked from PUBLIC and
-- granted only to police_runtime, plus an in-function realm guard.

GRANT SELECT ON bookings, tenants, rooms TO rls_exempt;

-- (1) SCREENING: hash + correlation ids. No name, no contact, no money.
DROP FUNCTION IF EXISTS police_screening_candidate(uuid);
CREATE FUNCTION police_screening_candidate(p_booking_id uuid)
RETURNS TABLE (
  booking_id          uuid,
  tenant_id           uuid,
  guest_registry_hash text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT b.id, b.tenant_id, b.guest_registry_hash
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND public.app_realm() = 'police'
$$;
ALTER FUNCTION police_screening_candidate(uuid) OWNER TO rls_exempt;
REVOKE ALL ON FUNCTION police_screening_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION police_screening_candidate(uuid) TO police_runtime;

-- (2) DISPATCH: only for RECORDED matches.
-- Guarded on `wanted_persons.district`, which arrives in a LATER revision
-- than this script's first run (same convention as the police_officers and
-- contact_requests blocks). Revision b8d2ea53c621 re-runs this script once the
-- column exists, and also creates the function directly.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name  = 'wanted_persons'
      AND column_name = 'district'
  ) THEN
    EXECUTE $ddl$
    -- (2) DISPATCH: only for RECORDED matches. Driven by police_matches, so a
    -- booking that never matched the watchlist has no row here at all.
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
    SET search_path = pg_catalog, public AS $body$
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
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500)
    $body$;
    ALTER FUNCTION police_match_dispatch(uuid, text, int) OWNER TO rls_exempt;
    REVOKE ALL ON FUNCTION police_match_dispatch(uuid, text, int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION police_match_dispatch(uuid, text, int) TO police_runtime;
    $ddl$;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 7. Marketplace realm — the PUBLIC, unauthenticated guest surface
-- ---------------------------------------------------------------------------
-- Sessions opened for guest discovery set app.realm = 'marketplace'. They can
-- read ONLY what belongs on a public marketplace: active hotels, active
-- rooms, active restaurants, available menu items. No booking rows, no
-- users, no wallets — those policies simply don't match this realm.

DROP POLICY IF EXISTS marketplace_read ON tenants;
CREATE POLICY marketplace_read ON tenants
  FOR SELECT USING (app_realm() = 'marketplace' AND is_active);

DROP POLICY IF EXISTS marketplace_read ON rooms;
CREATE POLICY marketplace_read ON rooms
  FOR SELECT USING (app_realm() = 'marketplace' AND is_active);

DROP POLICY IF EXISTS marketplace_read ON restaurants;
CREATE POLICY marketplace_read ON restaurants
  FOR SELECT USING (app_realm() = 'marketplace' AND is_active);

DROP POLICY IF EXISTS marketplace_read ON food_items;
CREATE POLICY marketplace_read ON food_items
  FOR SELECT USING (app_realm() = 'marketplace' AND is_available);

-- Availability checks need to CONSULT bookings without EXPOSING them.
-- A SECURITY DEFINER function owned by a non-login BYPASSRLS role returns
-- only a count — the marketplace realm never gains SELECT on booking rows.
-- rls_exempt is created in section 0 (the ledger trigger needs it earlier).
GRANT SELECT ON rooms, bookings TO rls_exempt;

CREATE OR REPLACE FUNCTION tenant_available_rooms(
  p_tenant_id uuid, p_check_in date, p_check_out date
) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
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
$$;
ALTER FUNCTION tenant_available_rooms(uuid, date, date) OWNER TO rls_exempt;
REVOKE ALL ON FUNCTION tenant_available_rooms(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_available_rooms(uuid, date, date)
  TO app_runtime, platform_runtime;

-- ---------------------------------------------------------------------------
-- 8. Platform-admin REDACTED police-alert projection
-- ---------------------------------------------------------------------------
-- The police realm is invisible to app_runtime (grants revoked above). But
-- the platform operator has a legitimate need to SEE that matches are
-- happening — WITHOUT breaching the realm or ever touching raw РД.
--
-- This SECURITY DEFINER function (owner = rls_exempt, BYPASSRLS) reads
-- police_matches and returns METADATA ONLY: who was flagged, which hotel /
-- room / booking, when, and the review status. It never exposes the raw
-- registry number (which is not stored anywhere) NOR the registry_hash.
--
-- Two locks keep this from becoming a leak despite EXECUTE being granted to
-- the shared app_runtime role:
--   (a) the WHERE app_is_platform_admin() guard — a hotel/restaurant/
--       reception session (app.user_role != 'PLATFORM_ADMIN') gets ZERO
--       rows, even though it can call the function;
--   (b) the function returns a fixed, redacted column set — callers cannot
--       widen it.
-- SECURITY DEFINER changes the executing ROLE, not the session GUCs, so
-- app_is_platform_admin() still reflects the true caller.
GRANT SELECT ON police_matches, wanted_persons, tenants, rooms, bookings
  TO rls_exempt;

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
SET search_path = pg_catalog, public AS $$
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
  WHERE public.app_is_platform_admin()   -- the guard: no rows for non-admins
  ORDER BY pm.matched_at DESC
  -- Bounded: an authenticated caller cannot request an unbounded result set.
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
$$;
ALTER FUNCTION admin_police_alerts(int) OWNER TO rls_exempt;
REVOKE ALL ON FUNCTION admin_police_alerts(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_police_alerts(int) TO platform_runtime;
REVOKE EXECUTE ON FUNCTION admin_police_alerts(int) FROM app_runtime;

COMMIT;

-- ===========================================================================
-- Smoke test (run manually):
--   SET ROLE app_runtime;
--   BEGIN;
--     SET LOCAL app.user_role = 'RECEPTION';
--     SET LOCAL app.tenant_id = '<hotel-A-uuid>';
--     SELECT count(*) FROM rooms;          -- only hotel A's rooms
--     SELECT count(*) FROM wanted_persons; -- ERROR: permission denied
--   ROLLBACK;
-- ===========================================================================
