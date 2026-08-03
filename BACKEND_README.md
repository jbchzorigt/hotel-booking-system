# ZuchiModern — Backend

**ZuchiModern** is a B2B2C Hotel PMS & Marketplace SaaS: hotels subscribe and
manage rooms/staff/housekeeping, guests discover and book rooms and pay via
QPay, nearby restaurants sell in-room dining, and an isolated Police realm
screens guest check-ins against a wanted-persons watchlist.

This document covers the **backend** (`app/`).

- **Framework:** FastAPI (async), Pydantic v2
- **Database:** PostgreSQL 16 with **Row-Level Security (RLS)** and a GiST
  no-double-booking exclusion constraint
- **ORM / migrations:** SQLAlchemy 2.0 (async, asyncpg) + Alembic
  (10 revisions; schema, RLS policies, roles and grants all ship as migrations)
- **Cache / realtime:** Redis 7 (payment idempotency, WebSocket pub/sub,
  janitor coordination)
- **Auth:** JWT (PyJWT, HS256) + passlib/bcrypt
- **Tests:** an ordered end-to-end pytest suite (`tests/integration_test.py`,
  27 tests) run in CI against live PostgreSQL + Redis service containers

---

## 1. System Overview

The backend exposes ~73 versioned HTTP routes under `/api/v1` plus WebSocket
channels, organized into routers by actor: guest/public marketplace,
reception, housekeeping, hotel management, restaurant, platform admin, auth,
and the police realm. A single FastAPI app (`app/main.py`) mounts them, runs a
background WebSocket relay and a booking-expiry **janitor** on startup, and
serves uploaded menu images from `/static`.

The design is **fail-fast in production**: `app/core/config.py` refuses to boot
under `APP_ENV=production` if any secret is still a development default, if
mocks are enabled, or if CORS allows non-HTTPS origins.

---

## 2. Core Architecture

### 2.1 Multi-tenant Row-Level Security (RLS)

Tenant isolation is enforced **by PostgreSQL itself**, not just by application
code — a bug in a router cannot leak another hotel's data. There are **four
security realms**, each backed by a distinct DB session that pins identity via
transaction-scoped GUCs (`SET LOCAL app.*`) which the RLS policies read:

| Realm | DB login role | Sees |
|---|---|---|
| **App / hotel** | `app_runtime` | rows where `tenant_id` (or `restaurant_id`) matches the caller's token; `FORCE ROW LEVEL SECURITY` applies even to the table owner |
| **Platform** | `platform_runtime` (**separate login role**) + GUC `app.user_role = PLATFORM_ADMIN` | all tenants — for reconciliation, wallets, the append-only ledger |
| **Police** | `police_runtime` (**separate DB credentials**) | its own `police_officers` / `wanted_persons` / `police_matches` / audit tables; `app_runtime` holds `REVOKE ALL` on these |
| **Marketplace** | `app_runtime` (GUC `app.realm = marketplace`) | public reads only: active hotels/rooms/restaurants/available menu items |

Key properties:

- **Transaction-scoped GUCs** (`SET LOCAL`) mean pooled connections can never
  leak one request's identity into the next.
- **Unset context fails closed** — a session with no identity GUC matches no
  rows.
- Availability for the public realm is computed by a `SECURITY DEFINER`
  function (`tenant_available_rooms`) so guests get room counts **without** the
  booking rows ever being exposed.
- Registry numbers (national ID / РД) are **never stored** — only salted
  HMAC-SHA256 hashes bridge the app and police realms.

The single source of truth for roles, grants, and policies is
[`scripts/enable_rls.sql`](scripts/enable_rls.sql), re-applied idempotently by
the Alembic RLS revisions.

### 2.2 Role-Based Access Control (RBAC)

RBAC is the first of three independent layers (RBAC → identity GUCs → RLS
policies) that must all agree before a row is visible.

`UserRole`:

| Role | Scope | Responsibilities |
|---|---|---|
| `PLATFORM_ADMIN` | none (global) | tenants, wallets, ledger, override/no-show approvals, police oversight |
| `HOTEL_ADMIN` | one `tenant_id` | owns a hotel; provisions staff and restaurant-manager credentials |
| `MANAGER` | one `tenant_id` | rooms, minibar catalogue, restaurant registration |
| `RECEPTION` | one `tenant_id` | check-in / PIN verification / checkout, walk-ins |
| `CLEANER` | one `tenant_id` | housekeeping state, minibar reports |
| `RESTAURANT_OWNER` | one `restaurant_id` | menu + order management (restaurant realm) |
| `GUEST` | none | B2C marketplace guest (e-Mongolia SSO) |

**Police officers are not `users`** — they authenticate through their own
`police_officers` table and receive a `realm="police"` JWT via
`POST /api/v1/police/login`. The `users.role_realm_consistency` CHECK
constraint enforces the scope rules above at the database level (e.g. a
restaurant account must carry a `restaurant_id` and no `tenant_id`).

FastAPI dependencies `require_roles(...)` (RBAC gate) and `get_scoped_session`
(RLS session selector) wire this together in `app/dependencies/auth.py`.

---

## 3. Key Business Logic

### 3.1 Zero-Trust PIN Verification

Escrow is released to the hotel **only on verified guest arrival**, not merely
on payment. When a booking is **funded** (marketplace confirm step or the QPay
webhook), the backend generates a random **6-digit `pin_code`** and stores it
on the booking. The guest retrieves it from the funded booking-status poll
(`GET /api/v1/public/bookings/{id}` — revealed only once `is_funded`; the
opaque `booking_id` is the retrieval capability).

At the desk:

- `POST /api/v1/reception/bookings/{id}/verify-pin` — a **constant-time**
  comparison (`hmac.compare_digest`). On match: `pin_verified = True`,
  booking → `CHECKED_IN`, room → `OCCUPIED`, and the escrow is **released**.
  A wrong PIN returns `400` with the funds **still held in escrow**. An
  optional `registry_number` keeps the KHUR identity check + police screening
  path alive.
- `POST /api/v1/reception/bookings/{id}/request-override` — a guest who lost
  the PIN is escalated (flag only).

Manual resolution (platform admin):

- `GET /api/v1/admin/bookings/overrides` — the pending manual check-in queue.
- `POST /api/v1/admin/bookings/{id}/approve-override` — admin judgement
  substitutes for the PIN → verified + `CHECKED_IN` + escrow released.
- `POST /api/v1/admin/bookings/{id}/process-no-show` — one-night penalty to the
  hotel (through the standard split), the remainder mock-refunded to the guest,
  booking → `NO_SHOW` (which frees the GiST date range for resale).

Because the release trigger moved to arrival, **checkout is idempotent**: if
escrow was already released at check-in it synthesises the settlement from the
persisted split — no double credit. Walk-ins and classic check-ins still
release at checkout, unchanged.

### 3.2 Escrow & Dynamic Platform Fee (the snapshot pattern)

Money never moves directly between guest and hotel — the **platform is the
merchant of record** and holds funds in escrow:

```
guest pays ──► escrow HELD (platform custody)
                    │
      verified arrival / checkout
                    ▼
         release_booking_escrow():
           5%  ─► platform wallet + immutable ledger entry
           95% ─► hotel wallet
```

**Dynamic fee.** Each `Tenant` has a `platform_fee_percent` column
(default `5.00`, editable via `PATCH /api/v1/admin/tenants/{id}`).

**The snapshot pattern is the important part.** The fee is **frozen onto each
booking/order at creation time** as a fraction: `commission_rate =
tenant.platform_fee_percent / 100`. The escrow release reads that *snapshotted*
`commission_rate` — never the tenant's current value. Consequences:

- Repricing a hotel's fee is **forward-looking only** — it re-rates future
  bookings and never rewrites the split on a stay the guest already paid for.
- The escrow release (`EscrowService.release_booking_escrow`) is a single
  locked transaction: lock the payable → credit the platform (with a ledger
  entry) → credit the merchant wallet → flip escrow to `RELEASED`.

The `platform_ledger_entries` table is **append-only and authoritative**, and
since revision `a7c1d9e42b10` that is enforced by PostgreSQL rather than by
convention: no runtime role holds `UPDATE`/`DELETE`/`TRUNCATE`, the RLS
policies are `FOR SELECT` + `FOR INSERT` only (so no policy could admit a
mutation even if a privilege were mistakenly re-granted), and a trigger owned
by the NOLOGIN `rls_exempt` role raises on any attempt — runtime roles cannot
disable or replace it, because that requires ownership. Refunds, corrections
and chargebacks are posted as **new compensating entries**. Wallet balances
are a cache reconciled against the ledger. QPay payment funding is
**idempotent by construction** — a single
`UPDATE ... WHERE status='PENDING' RETURNING id` funds each booking/order
exactly once no matter how many times (or how concurrently) the webhook fires.

---

## 3b. Security boundaries — what is and is not enforced

Written after the 2026-08-03 adversarial audit. Every row states only what is
actually enforced by code or by the database; the "not defended" column is
deliberately explicit, because an overstated guarantee is worse than a known
gap.

| Boundary | Enforced by | Defends against | Does **not** defend against |
|---|---|---|---|
| Tenant isolation | RLS policies on `tenant_id` (`FORCE ROW LEVEL SECURITY`), driven by the `app.tenant_id` GUC | a missing `WHERE` clause in application code; a tampered tenant claim in a JWT (signature validation rejects it before the GUC is ever set) | **arbitrary SQL execution under `app_runtime`, and leaked `app_runtime` credentials** — both can re-pin `app.tenant_id` to another tenant. See "Known limitation" below |
| Platform privilege | `app_is_platform_admin()` requires `session_user = 'platform_runtime'` **and** the role GUC; `app_runtime` is not a member of that role, so `SET ROLE` fails | SQL injection inside a tenant request; a leaked `app_runtime` password | compromise of the app host, which can read the platform DSN from its own environment |
| Ledger immutability | no `UPDATE`/`DELETE`/`TRUNCATE` privilege for any runtime role; `FOR SELECT` + `FOR INSERT` policies only; trigger owned by NOLOGIN `rls_exempt` | any runtime role rewriting or erasing financial history | a database superuser (who could drop the table); this is why superuser credentials are not used at runtime |
| Police data isolation | `REVOKE ALL` on police tables from `app_runtime`/`platform_runtime`; police reads business data only via two fixed `SECURITY DEFINER` projections | SQL injection under an app credential; column over-exposure to the police realm | **compromise of the app host — see below** |
| Cross-realm tokens | separate signing keys, issuers and audiences; realm-specific decoders (`decode_app_access_token` / `decode_police_access_token`); the realm is an input to validation, never read from the token first | a stolen app key minting police credentials, and vice versa; alg confusion; audience replay | theft of *both* keys |

### Known limitation: tenant identity is a session GUC (MEDIUM, open)

`app.tenant_id` is a session variable that the `app_runtime` connection sets
for itself. That is exactly what makes it robust against *application* bugs —
a forgotten `WHERE tenant_id = ...` cannot leak another hotel's rows, because
the policy applies regardless. It is **not** robust against an attacker who
can execute arbitrary statements on that connection.

Proven against the hardened database:

```
-- as app_runtime, one transaction
SET LOCAL app.user_role = 'RECEPTION';
SET LOCAL app.tenant_id = '<tenant A>';   SELECT count(*) FROM rooms;  -- 1
SET LOCAL app.tenant_id = '<tenant B>';   SELECT count(*) FROM rooms;  -- 3
```

So the threat model must be stated precisely:

| Scenario | Outcome |
|---|---|
| Missing tenant filter in a query | **Protected** — the policy filters anyway |
| Malicious JWT with an altered tenant claim | **Protected** — signature validation rejects the token; the GUC is never set from an unverified claim |
| Arbitrary SQL execution under `app_runtime` | **NOT protected** — the attacker re-pins `app.tenant_id` and moves laterally between tenants |
| Leaked `app_runtime` credentials | **NOT protected** — same self-assertion, no application involved |
| Escalation to platform scope (wallet, ledger, cross-tenant) | **Protected** — requires `session_user = 'platform_runtime'`, a distinct login role with no membership path from `app_runtime` (revision `c9e3fb64d732`) |

Note the asymmetry that the platform work introduced: privilege *escalation*
is now bound to a DB login role, but *lateral* movement within the tenant tier
is not, because all tenants share one runtime role.

**Why this is not closed here.** Closing it means changing how tenant identity
is established at the database boundary, and every available option is a
larger architectural change than this audit's scope:

* a login role per tenant (identity becomes `session_user`) — does not scale to
  a marketplace with thousands of hotels, and turns onboarding into role
  provisioning;
* a connection pool keyed by tenant with `SET SESSION AUTHORIZATION` — requires
  superuser to switch back, so it moves the problem rather than solving it;
* signed tenant context verified inside the policy (e.g. the GUC carries an
  HMAC over `tenant_id` that a `SECURITY DEFINER` verifier checks against a key
  the runtime role cannot read) — viable, and the smallest sound design, but it
  changes every session-open path and needs its own key-management story.

Until one of those lands, tenant RLS should be described as **a guard against
application bugs, not a containment boundary for a compromised app credential**.
`test_s_tenant_guc_lateral_movement_is_a_known_limitation` characterises the
current behaviour so that any future change to it fails the suite loudly.

### Unresolved: police process boundary (HIGH)

The police realm has its own DB role, its own signing key and its own engine —
but it still runs **inside the same FastAPI process** as the public and hotel
application, and that process holds `POSTGRES_POLICE_PASSWORD` and
`POLICE_JWT_SECRET_KEY` in its own environment. Anyone who achieves code
execution or arbitrary file read on the application host obtains both.

**Separate PostgreSQL credentials inside one process are not a process,
host, secret, or deployment boundary.** Any claim that "a fully compromised
app server cannot read police data" is false until all of the following hold:

1. separate process / deployment entrypoints for the app and police workloads;
2. separately injected secrets, with the police secrets absent from the
   public/hotel process environment;
3. network restrictions so only the police workload can reach the police
   database role;
4. no police database password or police JWT key in the public/hotel process.

Until then this remains an open HIGH-severity finding, tracked here rather
than described as mitigated.

---

### Deployment compatibility — BREAKING changes in this security release

These changes are **not backward compatible at runtime**. Read before rolling out.

**1. All existing JWTs become invalid.** Tokens are now validated against
realm-specific keys, issuers and audiences, and the `aud` claim is required.
Every token issued before this release fails validation — app *and* police.
There is no grace period and no dual-validation fallback, deliberately:
accepting old tokens would mean keeping the shared-key path alive, which is
the vulnerability. **All users must authenticate again after deployment.**
Expect a burst of 401s and re-logins; make sure the frontend treats a 401 as
"redirect to login" rather than as an error state.

**2. Environment variables must be provisioned BEFORE rollout.** The
application will not start without them, and in production the fail-fast guard
additionally requires them to be distinct:

| Variable | Notes |
|---|---|
| `POLICE_JWT_SECRET_KEY` | must differ from `JWT_SECRET_KEY`, ≥32 chars |
| `POSTGRES_PLATFORM_USER` | must differ from `POSTGRES_USER` |
| `POSTGRES_PLATFORM_PASSWORD` | must differ from `POSTGRES_PASSWORD` |
| `JWT_APP_ISSUER` / `JWT_APP_AUDIENCE` | defaults are fine; must differ from the police pair |
| `JWT_POLICE_ISSUER` / `JWT_POLICE_AUDIENCE` | as above |

**3. Migration and rollout must be ordered — the old application is NOT
compatible with the new grants.** Revision `c9e3fb64d732` removes
`app_runtime`'s access to `platform_accounts` and `platform_ledger_entries`
and rebinds `app_is_platform_admin()` to `session_user = 'platform_runtime'`.
An old application instance still connecting as `app_runtime` for platform
work will fail every escrow settlement, admin dashboard and platform-
orchestrated booking write once those migrations land.

Required order:

1. Create and password the `platform_runtime` role in the target database
   (out of band, real secret — **not** `scripts/provision_local_roles.sql`,
   which is local-only).
2. Provision the new environment variables on the new application version.
3. Deploy the new application version **and** run `alembic upgrade head`
   together, as a single cutover — not a rolling deploy that leaves old
   instances serving traffic.
4. Verify: admin revenue dashboard `200`, a police login `200`, and an
   app-realm token against a police endpoint `401`.

If a rolling deploy is unavoidable, the migrations must land *after* every old
instance has been drained. There is no window in which old and new
application versions are both correct against the same database.

**4. Rollback.** All four revisions have downgrades, but each re-opens the
finding it closed (documented in the revision docstrings). A rollback also
does not re-validate old tokens — users must log in again either way.

---

## 4. Setup & Local Development

### Prerequisites

- Python **3.13**, Docker + Docker Compose, `psql` client (optional)

### 1. Environment

```bash
cp .env.example .env
```

The defaults target the local Docker stack. **Every secret in `.env` is a
development default** — the production fail-fast guard rejects them all under
`APP_ENV=production`.

### 2. Start PostgreSQL + Redis

```bash
docker compose up -d
```

This starts PostgreSQL 16 on host port **55440** and Redis 7 on **6379**
(non-default ports to avoid clashing with a system Postgres/Redis).

### 3. Install dependencies

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Run migrations

Migrations run as the schema **owner** (a superuser), never as `app_runtime`
(which RLS applies to). Point Alembic at the owner DSN via
`MIGRATIONS_DATABASE_URL`:

```bash
export MIGRATIONS_DATABASE_URL='postgresql+psycopg://hotel:<owner-password>@localhost:55440/hotel_marketplace'
alembic upgrade head
```

This creates the schema, the `app_runtime` / `platform_runtime` /
`police_runtime` / `rls_exempt` roles, all RLS policies, and helper functions.

### 4b. Provision the local runtime role passwords

Migrations create the runtime login roles but deliberately **do not set usable
passwords** — a migration is source-controlled and replayed everywhere, so it
must never carry a credential. Roles are created with the placeholder
`CHANGE_ME_IN_PRODUCTION`, and an existing role's password is never
overwritten. Assign the local development passwords (the ones `.env.example`
ships) with:

```bash
docker exec -i hotel-platform-postgres psql -U hotel -d hotel_marketplace -v ON_ERROR_STOP=1 < scripts/provision_local_roles.sql
```

Repeat for the E2E scratch database if you will run the test suite:

```bash
docker exec -i hotel-platform-postgres psql -U hotel -d hotel_marketplace_test -v ON_ERROR_STOP=1 < scripts/provision_local_roles.sql
```

(Roles are cluster-wide, so the second run is a no-op for the passwords; it is
listed only so the command is obvious when you bootstrap the test DB.)

**In production, do not run this script.** Assign real secrets out of band
(`ALTER ROLE ... PASSWORD ...` from your secret manager) and set
`POSTGRES_PASSWORD`, `POSTGRES_PLATFORM_PASSWORD` and
`POSTGRES_POLICE_PASSWORD` to match. Startup refuses any placeholder, and
refuses platform/police credentials that equal the tenant credential.

### 5. Bootstrap the platform account and first accounts

```bash
python3 create_platform_account.py # singleton platform wallet (REQUIRED)
python3 create_admin.py            # -> admin@hotel.mn / Admin123!
python3 create_police_officer.py   # -> badge P-1000  / Police123!
```

`create_platform_account.py` seeds the single `platform_accounts` row that
escrow settlement credits and the admin revenue dashboard reads. Without it a
fresh install looks healthy until the first platform operation, which then
fails with `NoResultFound` (500) or `PlatformAccountMissingError`. All three
scripts are idempotent and never overwrite existing rows or balances.

### 6. Run the server

```bash
uvicorn app.main:app --port 8010 --reload
```

Interactive docs: `http://localhost:8010/docs` (disabled in production).
Health check: `GET /healthz`.

### Tests

```bash
# migrate the scratch DB first, then:
PYTHONPATH="$PWD" pytest -q
```

The suite is an ordered end-to-end scenario (it truncates + seeds its own
database) covering escrow, RLS isolation, check-in + police WebSocket alerts,
the 5/95 split, dynamic per-tenant fees, in-room dining, image uploads, and the
full zero-trust PIN / override / no-show flows. CI (`.github/workflows/ci.yml`)
runs `alembic upgrade head` then `pytest -q` against service containers.

> **Note on ports:** the local stack deliberately uses PostgreSQL `55440` and
> Redis `6379`; keep `.env` in sync if you change `docker-compose.yml`.

---

## 5. External Integrations (mocked — need production credentials)

All three are **mock adapters** today, selected by feature flags. The
production fail-fast guard forbids the mocks and their default secrets under
`APP_ENV=production`, so switching to real providers is a config change plus a
real HTTP adapter.

| Integration | Purpose | Flag | Production TODO |
|---|---|---|---|
| **QPay** | payment invoices + HMAC-signed payment webhook | `QPAY_USE_MOCKS=true` | real QPay merchant credentials + a real HTTP client; set `QPAY_WEBHOOK_SECRET` |
| **KHUR** (ХУР) | citizen registry lookup — verifies guest identity at check-in / watchlist add | `GOV_USE_MOCKS=true` | `KHUR_API_BASE_URL` + `KHUR_API_KEY` |
| **e-Mongolia** | OAuth SSO for B2C guest login | `GOV_USE_MOCKS=true` | `EMONGOLIA_CLIENT_ID` / `EMONGOLIA_CLIENT_SECRET` / redirect URI |

The mock QPay client auto-approves invoices and can sign webhooks for tests;
the mock KHUR/e-Mongolia adapters return deterministic identities so the
booking → check-in → police-screening flow is reproducible without live state
APIs.

---

## Repository Map

| Path | Contents |
|---|---|
| `app/main.py` | app assembly, router mounting, lifespan (WS relay + janitor), `/static` |
| `app/core/` | config (fail-fast), DB engines/sessions (RLS), security (JWT), passwords, Redis |
| `app/models/domain.py` | all SQLAlchemy models |
| `app/api/` | routers (marketplace, reception, cleaner, manager, restaurant, admin, auth, police, uploads, public food) |
| `app/services/` | escrow/payments, QPay, gov (KHUR + e-Mongolia), police screening, janitor |
| `app/dependencies/auth.py` | RBAC gates + RLS session selection |
| `alembic/` | migrations (schema + RLS) |
| `scripts/enable_rls.sql` | source of truth for roles, grants, RLS policies |
| `tests/` | ordered E2E pytest suite + fixtures |
