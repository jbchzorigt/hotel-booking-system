-- Runs once on first container boot (empty volume). Creates the databases
-- the project expects; schema + RLS + runtime roles come from Alembic.
CREATE DATABASE hotel_marketplace OWNER hotel;       -- local dev runtime
CREATE DATABASE hotel_marketplace_test OWNER hotel;  -- E2E scratch (integration_test.py)
