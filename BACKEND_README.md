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
| **Platform** | `app_runtime` (GUC `app.user_role = PLATFORM_ADMIN`) | all tenants — for reconciliation, wallets, the append-only ledger |
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

The `platform_ledger_entries` table is **append-only and authoritative**; the
wallet balances are a cache reconciled against it. QPay payment funding is
**idempotent by construction** — a single
`UPDATE ... WHERE status='PENDING' RETURNING id` funds each booking/order
exactly once no matter how many times (or how concurrently) the webhook fires.

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

This creates the schema, the `app_runtime` / `police_runtime` / `rls_exempt`
roles, all RLS policies, and helper functions.

### 5. Bootstrap a platform admin

```bash
python3 create_admin.py            # -> admin@hotel.mn / Admin123!
python3 create_police_officer.py   # -> badge P-1000  / Police123!
```

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
