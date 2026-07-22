# System Structure

A B2B2C **Hotel Management & Marketplace SaaS** for Mongolia: hotels run their
operations (front desk, housekeeping, minibar, staff), restaurants run in-room
dining, guests book and order via a public marketplace, and the General Police
Department screens check-ins against a wanted-persons registry — all with
escrow-protected QPay payments and strict multi-tenant isolation.

- **Backend:** FastAPI (async) + SQLAlchemy 2.0 + PostgreSQL 16 (Row-Level
  Security) + Redis (pub/sub, idempotency) + Alembic.
- **Frontend:** Next.js 15 (App Router) + React 19 + TypeScript + Tailwind +
  Zustand + Axios + shadcn-style UI.
- **Integrations (mock ⇄ real adapters):** KHUR/XYP (citizen registry),
  e-Mongolia (guest SSO), QPay (payments).

---

## 1. Repository layout

```
Final Project/
├── app/                        # FastAPI backend
│   ├── main.py                 # app assembly: routers, CORS, /static, WS, lifespan
│   ├── core/
│   │   ├── config.py           # typed settings + production fail-fast guard
│   │   ├── database.py         # async engines + RLS-scoped session factories
│   │   ├── security.py         # JWT create/verify (realm, role, scope claims)
│   │   ├── passwords.py        # bcrypt hashing + DUMMY_HASH (anti-enumeration)
│   │   └── redis.py            # Redis client
│   ├── dependencies/
│   │   └── auth.py             # AuthContext, require_roles / require_police, ScopedSession
│   ├── models/
│   │   ├── base.py             # Declarative base, mixins, typed columns
│   │   └── domain.py           # all tables + enums (single source of truth)
│   ├── api/                    # routers (one per bounded context) — see §4
│   └── services/               # gov, qpay, escrow, police screening, janitor — see §5
├── alembic/versions/           # migrations (schema + RLS + each feature) — see §7
├── scripts/enable_rls.sql      # RLS policies, realm roles, grants (source of truth)
├── static/uploads/             # user-uploaded menu images (gitignored, served by /static)
├── tests/                      # pytest E2E suite (conftest.py + integration_test.py)
├── create_admin.py             # bootstrap a PLATFORM_ADMIN
├── create_police_officer.py    # bootstrap a police officer (default P-1000)
├── docker-compose.yml          # Postgres 16 (:55440) + Redis 7 (:6379)
├── external_integration.md     # guide to swap mock adapters for real APIs
└── frontend/                   # Next.js app — see §3
```

---

## 2. Core architecture principles

1. **Realm-based Row-Level Security.** Every DB session is pinned to a realm +
   scope via `SET LOCAL` GUCs (`app.realm`, `app.tenant_id`, `app.restaurant_id`,
   `app.user_role`). Postgres RLS — not application code — is the last line of
   defense. Realms: `app` (hotel/restaurant/platform), `police`, `marketplace`
   (public reads). `scripts/enable_rls.sql` is the single source of truth.
2. **Police-realm hard isolation.** The app's DB role (`app_runtime`) has
   `REVOKE ALL` on `wanted_persons` / `police_matches` / `police_officers` /
   `police_audit_logs`. The police matcher/API run as a separate role
   (`police_runtime`). Even a fully compromised app server cannot read police
   data. The one bridge is a `SECURITY DEFINER` function returning a **redacted**
   projection to platform admins.
3. **PII minimization.** Raw registry numbers (РД) are **never stored** — only a
   salted HMAC hash (`compute_registry_hash`). Matching is a hash-equality join.
4. **Escrow payment model.** The platform is merchant of record. Funds are
   **HELD** on payment and **RELEASED** (95% merchant / 5% platform commission)
   on fulfilment. Money movements are append-only ledger entries.
5. **Idempotency by construction.** QPay webhooks and payment captures use a
   single atomic conditional `UPDATE ... WHERE status=PENDING RETURNING id`, so
   duplicate/concurrent deliveries fund exactly once.
6. **No double-booking at the DB.** A GiST exclusion constraint rejects
   overlapping live bookings on a room; the API maps the violation to `409`.
7. **Fail-fast config.** In production, known dev-default secrets, enabled mocks,
   or debug flags abort startup.

---

## 3. Frontend structure (`frontend/src/`)

App Router **route groups** keep the three audiences physically separate — no
shared chrome, independent guards:

```
app/
├── layout.tsx                       # root: fonts, <Toaster/>
├── (auth)/login/                    # staff/admin login → role-based redirect
├── (public)/                        # B2C marketplace — clean navbar/footer
│   ├── page.tsx                     # landing: hero, search, marquee, HotelCard grid, pricing
│   ├── hotel/[id]/                  # hotel detail + room selection
│   ├── checkout/                    # e-Mongolia SSO → QPay QR → poll → success
│   ├── booking/[booking_id]/dining/ # in-room dining: cart → QPay → "sent to kitchen"
│   └── join/                        # hotel onboarding lead capture
├── (dashboard)/                     # authenticated staff realms (DashboardLayout guard)
│   ├── admin/  admin/police/        # platform admin + redacted police oversight
│   ├── hotel/  manager/             # hotel admin + management (rooms/minibar/restaurants)
│   ├── reception/  cleaner/         # front desk + housekeeping
│   └── restaurant/                  # restaurant owner: KDS + menu CRUD
└── (police)/                        # standalone police portal (realm==="police" guard)
    └── police/{login,watchlist,alerts,audit}/
```

Supporting code:

| Path | Purpose |
|---|---|
| `store/authStore.ts` | Zustand: JWT + derived `role`/`realm`/scope, persisted; `ROLE_HOME` routing |
| `lib/axios.ts` | Axios instance (token interceptor, 401→logout) + `uploadImage()` + `assetUrl()` |
| `lib/jwt.ts` | client-side JWT claim decode (display only; never authz) |
| `hooks/useWebSocket.ts` | auto-reconnecting WS (backoff+jitter, stops on 1008) |
| `hooks/useRegistryLookup.ts` | debounced KHUR identity preview |
| `types/api.ts` | TS mirrors of every backend Pydantic schema |
| `components/ui/*` | shadcn-style primitives (button, dialog, table, tabs, form, …) |
| `components/public/HotelCard.tsx` | reusable card: scroll-snap image slider, glass pills, rating |

---

## 4. API surface (`app/api/`, prefix `/api/v1`)

WebSocket paths are **not** versioned (mounted at root).

| Router | Prefix | Realm / auth | Responsibility |
|---|---|---|---|
| `auth_router` | `/auth` | bootstrap → app | staff login, staff provisioning (`/users`) |
| `booking_router` | `/marketplace` | marketplace / platform | legacy geo search + hotel detail + sync book |
| `public_router` | `/public`, `/payments`, `/auth` | marketplace / platform | **B2C**: hotel search, QPay booking, `qpay-webhook`, e-Mongolia SSO, status poll, sandbox pay |
| `public_food_router` | `/public` | platform (booking-id capability) | **in-room dining**: vicinity menus, food order + QPay, status poll |
| `food_order_router` | `/marketplace` | marketplace | public menu browsing + legacy food order |
| `reception_router` | `/reception` | RECEPTION/MANAGER/HOTEL_ADMIN | check-in (KHUR), walk-in, checkout + invoice, desk minibar |
| `cleaner_router` | `/cleaner` | CLEANER/… | dirty & occupied rooms, mark-clean, minibar report |
| `manager_router` | `/manager`, `/restaurants` | MANAGER/HOTEL_ADMIN | rooms, minibar catalogue, vicinity restaurants, **restaurant-manager provisioning** |
| `restaurant_router` | `/restaurant` | RESTAURANT_OWNER | menu CRUD, order feed (KDS), fulfilment state machine |
| `admin_router` | `/admin` | PLATFORM_ADMIN | revenue dashboard, top rooms, xlsx export, **redacted police alerts** |
| `tenant_admin_router` | `/admin/tenants` | PLATFORM_ADMIN | provision hotel + first HOTEL_ADMIN |
| `onboarding_router` | `/onboarding`, `/admin/onboarding` | public + PLATFORM_ADMIN | sales lead capture + review/status |
| `police_router` | `/police` | **police realm** | officer login, KHUR watchlist, match feed, resolve/arrest, audit log |
| `upload_router` | `/upload` | content roles | validated image upload → `/static/uploads/…` |
| `websocket_manager` | `/ws/*` | token in query | reception / restaurant / police live feeds (Redis relay) |

---

## 5. Services (`app/services/`)

| Service | Role |
|---|---|
| `gov_service.py` | KHUR citizen lookup + e-Mongolia OAuth — **Mock/Http adapters** behind `Port` protocols (deterministic mocks for dev/CI) |
| `qpay_service.py` | invoice creation (QR text/link) + HMAC webhook signing/verification — Mock/Http adapters |
| `payment_escrow_service.py` | capture → HELD, release → 95/5 split, ledger writes; row-locked, idempotency-keyed |
| `police_service.py` | post-commit check-in screening (police realm), Redis alert publish |
| `janitor_service.py` | background sweep: cancel stale unpaid PENDING bookings/orders, free GiST dates |

---

## 6. Data model & payment lifecycle

**Key tables** (`app/models/domain.py`): `Tenant`, `User`, `Room`,
`MinibarCategory/Item/Consumption`, `Booking`, `Restaurant`, `FoodItem`,
`FoodOrder`, `FoodOrderItem`, `PlatformAccount`, `PlatformLedgerEntry`,
`ContactRequest`, `WantedPerson`, `PoliceMatch`, `PoliceOfficer`,
`PoliceAuditLog`.

**Roles** (`UserRole`): `PLATFORM_ADMIN`, `HOTEL_ADMIN`, `MANAGER`, `RECEPTION`,
`CLEANER`, `RESTAURANT_OWNER`, `GUEST`. (`POLICE` is a separate realm principal,
not a `UserRole`.)

**Booking lifecycle:**
```
search → POST /public/bookings (PENDING, escrow NOT_FUNDED, + QPay invoice)
       → guest pays → POST /payments/qpay-webhook (idempotent) → CONFIRMED / HELD
       → reception check-in (KHUR verify → police screening) → CHECKED_IN
       → checkout: settle minibar + release room escrow (95/5) → CHECKED_OUT / VACANT_DIRTY
```

**In-room dining lifecycle:**
```
POST /public/bookings/{id}/orders (PLACED, NOT_FUNDED, + invoice)
   → webhook funds → HELD → kitchen alerted over WS (NEW_FOOD_ORDER)
   → PLACED → ACCEPTED → PREPARING → DELIVERED (releases escrow 95/5)
```

**Realtime (Redis pub/sub → WS relay):** `ws:tenant:{id}:reception` (minibar
reports), `ws:restaurant:{id}:orders` (new paid orders), `police:alerts`
(wanted-person matches).

---

## 7. Migrations (Alembic)

Ordered; each feature ships schema + a re-run of the idempotent RLS script.

1. `35d2dfee301a` — initial schema
2. `a1b2c3d4e5f6` — enable RLS, realms, grants, helper functions
3. `af80fbe033ec` — contact_requests (lead capture)
4. `c3d4e5f6a7b8` — admin redacted police-alerts (SECURITY DEFINER projection)
5. `4838509f305a` — police realm: officers, audit log, wanted district/status
6. `b7e1c9d2f4a3` — B2C GUEST role + `bookings.qpay_invoice_id`
7. `f6755ca9f68a` — food-order QPay invoice correlation
8. `b200544361f8` — `food_items.image_url`

---

## 8. Local development

```bash
# 1. Infra (Postgres :55440, Redis :6379)
docker compose up -d

# 2. Migrate (as the schema owner, not app_runtime)
MIGRATIONS_DATABASE_URL='postgresql+psycopg://hotel:...@localhost:55440/hotel_marketplace' \
  alembic upgrade head

# 3. Backend (app is at the repo ROOT — no backend/ dir)
python3 -m uvicorn app.main:app --port 8000 --reload

# 4. Frontend
cd frontend && npm install && npm run dev     # http://localhost:3000

# 5. E2E suite (pytest; conftest sets env)
python3 -m pytest -q
```

Bootstrap accounts: `create_admin.py` (platform admin), `create_police_officer.py`
(police, default badge `P-1000`). CI (`.github/workflows/ci.yml`) runs the
backend E2E suite + frontend lint/type-check/build on every PR.

> **Note:** the test database can drift behind the models — run
> `alembic upgrade head` against both `hotel_marketplace` and
> `hotel_marketplace_test` after adding a migration.
