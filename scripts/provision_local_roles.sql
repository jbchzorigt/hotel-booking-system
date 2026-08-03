-- ===========================================================================
-- LOCAL DEVELOPMENT ONLY — runtime role passwords
-- ===========================================================================
--                        ⚠  DO NOT RUN IN PRODUCTION  ⚠
--
-- The Alembic migrations CREATE the three runtime login roles, but they
-- deliberately do not set usable passwords: a migration is source-controlled
-- and replayed everywhere, so it must never carry a credential. Roles are
-- created with the placeholder 'CHANGE_ME_IN_PRODUCTION' and existing roles
-- are never overwritten.
--
-- That leaves exactly one gap for a new developer: the roles exist but the
-- passwords do not match `.env`. This script closes that gap for LOCAL work
-- only, by assigning the same throwaway passwords that `.env.example` ships.
-- They are safe to keep in source control for the same reason the owner
-- password in `docker-compose.yml` is: this stack listens on localhost and
-- holds nothing but synthetic data.
--
-- PRODUCTION provisioning is deliberately OUT of scope here. There, run the
-- equivalent ALTER ROLE statements out of band with real secrets from your
-- secret manager, and set POSTGRES_PASSWORD / POSTGRES_PLATFORM_PASSWORD /
-- POSTGRES_POLICE_PASSWORD to match. The application's fail-fast guard
-- refuses to boot in production if any of them is a known placeholder, or if
-- the platform/police credentials equal the tenant one.
--
-- Usage (as the schema owner, AFTER `alembic upgrade head`):
--
--   docker exec -i hotel-platform-postgres \
--     psql -U hotel -d hotel_marketplace -v ON_ERROR_STOP=1 \
--     < scripts/provision_local_roles.sql
--
-- Idempotent: creates a role only if missing, then (re)sets its password.
-- ===========================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 130000 THEN
    RAISE EXCEPTION 'PostgreSQL 13+ required';
  END IF;

  -- Tenant runtime — ordinary hotel/restaurant/guest request path.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
  ALTER ROLE app_runtime LOGIN PASSWORD 'local-dev-app-runtime-pw';

  -- Platform runtime — cross-tenant workflows (escrow, reconciliation,
  -- admin reporting). MUST be a different credential from app_runtime: the
  -- whole point of revision c9e3fb64d732 is that a tenant connection cannot
  -- become this role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime') THEN
    CREATE ROLE platform_runtime LOGIN;
  END IF;
  ALTER ROLE platform_runtime LOGIN PASSWORD 'local-dev-platform-runtime-pw';

  -- Police runtime — the police realm's own engine.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'police_runtime') THEN
    CREATE ROLE police_runtime LOGIN;
  END IF;
  ALTER ROLE police_runtime LOGIN PASSWORD 'local-dev-police-runtime-pw';
END
$$;

-- Report what a developer should now be able to connect as.
SELECT rolname AS provisioned_role, rolcanlogin AS can_login
FROM pg_roles
WHERE rolname IN ('app_runtime', 'platform_runtime', 'police_runtime')
ORDER BY rolname;
