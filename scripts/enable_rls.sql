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
DO $$
BEGIN
  -- Runtime role used by the FastAPI application. RLS applies to it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
  -- Dedicated role for the police matcher/API. Separate credentials mean a
  -- compromised app server still cannot read the police realm.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
    CREATE ROLE police_runtime LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_runtime, police_runtime;

-- App realm: CRUD on business tables; NOTHING on police tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, rooms, minibar_categories, minibar_items,
  minibar_consumptions, bookings, restaurants, food_items,
  food_orders, food_order_items,
  platform_accounts, platform_ledger_entries
TO app_runtime;
REVOKE ALL ON wanted_persons, police_matches FROM app_runtime;

-- Police realm: its tables, plus the minimum read surface needed to match
-- and dispatch (booking hashes, hotel geolocation, room number).
GRANT SELECT, INSERT, UPDATE ON wanted_persons, police_matches TO police_runtime;
GRANT SELECT ON bookings, tenants, rooms TO police_runtime;
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

CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_user_role() = 'PLATFORM_ADMIN'
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

DROP POLICY IF EXISTS platform_only ON platform_ledger_entries;
CREATE POLICY platform_only ON platform_ledger_entries
  FOR ALL
  USING       (app_is_platform_admin())
  WITH CHECK  (app_is_platform_admin());

-- Onboarding leads: written by the platform-orchestrated public endpoint,
-- readable/managed ONLY by platform admins. No hotel, restaurant, police
-- or marketplace identity can even prove the table is non-empty.
-- Guarded: contact_requests arrives in a LATER revision than this script's
-- first run, so on fresh installs revision a1b2c3d4e5f6 must skip it; the
-- revision that creates the table re-runs this script and applies it.
DO $$
BEGIN
  IF to_regclass('public.contact_requests') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON contact_requests TO app_runtime;
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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_exempt') THEN
    CREATE ROLE rls_exempt NOLOGIN BYPASSRLS;
  END IF;
END
$$;
GRANT SELECT ON rooms, bookings TO rls_exempt;

CREATE OR REPLACE FUNCTION tenant_available_rooms(
  p_tenant_id uuid, p_check_in date, p_check_out date
) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
$$;
ALTER FUNCTION tenant_available_rooms(uuid, date, date) OWNER TO rls_exempt;

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
