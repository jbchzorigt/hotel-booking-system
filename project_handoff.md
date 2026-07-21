# Project Handoff — Hotel Booking Marketplace & Management SaaS

> Generated 2026-07-21 for session migration. Every status claim below was
> **verified at generation time** (test run, lint, build, git state) — not
> assumed.

---

## 1. Project Overview & Tech Stack

A **B2B2C Hotel Booking Marketplace & PMS** for the Mongolian market:
hotels subscribe (3/6/9/12-month plans), guests book & pay via QPay,
nearby restaurants sell in-room dining, and a fully isolated Police realm
screens check-ins against a wanted-persons watchlist (KHUR-verified,
hash-only PII).

| Layer | Stack |
|---|---|
| Backend | FastAPI (async), SQLAlchemy 2.0, Alembic (9 revisions), Pydantic v2 |
| Database | PostgreSQL 16 (Docker, host port **55440**) — **Row-Level Security enforced**, GiST no-double-booking exclusion constraint |
| Cache / RT | Redis 7 (idempotency keys, WebSocket pub/sub relay, janitor coordination) |
| Frontend | Next.js 15 App Router, TypeScript, Tailwind, Zustand, Axios (in `frontend/`) |
| Auth | JWT (PyJWT, HS256), passlib+bcrypt; e-Mongolia SSO mock for B2C guests |
| Payments | QPay (mock adapter) — invoice + **HMAC-signed idempotent webhook** |
| Gov mocks | KHUR citizen registry + e-Mongolia (deterministic; `GOV_USE_MOCKS=true`) |
| CI | GitHub Actions (`.github/workflows/ci.yml`): PG16+Redis services → `alembic upgrade head` → `pytest -q`; frontend lint + typecheck + build |

### Security architecture (the load-bearing part)

Four **RLS realms**, enforced in PostgreSQL itself (transaction-scoped GUCs
via `set_config`, `FORCE ROW LEVEL SECURITY`, low-privilege login roles):

- **Hotel/app realm** (`app_runtime` role): tenant-isolated by `tenant_id`;
  restaurant accounts isolated by `restaurant_id`.
- **Platform realm**: `PLATFORM_ADMIN` GUC — wallets, ledger, cross-tenant ops.
- **Police realm** (`police_runtime` role — *separate DB credentials*): own
  login (`/police/login`), watchlist, matches, append-only audit log.
  `app_runtime` has `REVOKE ALL` on police tables. Raw registry numbers (РД)
  are **never stored** — only salted HMAC hashes.
- **Marketplace realm**: unauthenticated public reads (active hotels/rooms/
  menus only); availability via a `SECURITY DEFINER` fn so booking rows are
  never exposed.

**Roles** (`UserRole`): `PLATFORM_ADMIN`, `HOTEL_ADMIN`, `MANAGER`,
`RECEPTION`, `CLEANER`, `RESTAURANT_OWNER` (= restaurant manager), `GUEST`
(B2C SSO). Police officers live in their own `police_officers` table.

**Money**: escrow model — capture `NOT_FUNDED→HELD` (sync mock gateway or
async QPay webhook), release `HELD→RELEASED` with a **5% platform / 95%
merchant** split, append-only `platform_ledger_entries`. All webhook funding
is a single atomic `UPDATE … WHERE status='PENDING' RETURNING id` (proven
under 5× concurrent delivery). A janitor sweeps unpaid PENDING bookings /
PLACED orders (PG advisory lock elects one sweeper across workers).

---

## 2. Latest Achievements (recent commits, newest first — all merged)

| Commit | What |
|---|---|
| `3c006af` | **Manager-status badge + menu image file upload (frontend)** — restaurant tab shows onboarding status; menu dialog uploads real files via `fetch` multipart to `POST /api/v1/upload` |
| `c31bfe2` | **Menu image uploads + `has_manager` flag (backend)** — hardened upload endpoint (server-generated names, magic-byte sniffing, 5 MiB streamed cap, StaticFiles at `/static`), `food_items.image_url`, `has_manager` on `GET /manager/restaurants` |
| `a4c0bd3` | **B2C landing redesign** — hero, infinite marquee, reusable `HotelCard` component, restaurant-manager login surface |
| `65b6f98` | **HOTEL_ADMIN attaches manager credentials to an existing restaurant** — `POST /api/v1/restaurants/{id}/manager` (HOTEL_ADMIN-only, full security matrix tested) |
| `e0fe22f` | **In-room dining UI** — guest ordering flow + kitchen display system |
| `b4819e1` | **B2C in-room dining backend** — booking-bound menus, QPay food orders, idempotent webhook funding + post-commit kitchen WS alerts |

Merged to `main` via **PR #8** (`f223456`).

---

## 3. Current State — VERIFIED ✅

- **Backend**: `pytest -q` → **21 passed** (ordered E2E suite, Phases A–H:
  escrow idempotency, RLS isolation, check-in + police WS alert, checkout
  splits, marketplace, admin dashboards + xlsx, auth, janitor, in-room
  dining, uploads).
- **Frontend**: `npm run lint` → clean; `npm run build` → **compiles with
  zero errors** (verified at handoff time).
- **Git**: branch `feat/b2c-marketplace-qpay` fully pushed AND **fully
  merged into `origin/main`**. Working tree clean except untracked local
  scratch (`.claude/`, `SYSTEM_STRUCTURE.md`).
- **CI**: GitHub Actions pipeline live on push/PR to `main`.
- **Local run**: `docker compose up -d` (PG :55440 + Redis :6379) →
  `alembic upgrade head` (as owner, via `MIGRATIONS_DATABASE_URL`) →
  `python3 -m uvicorn app.main:app --port 8010 --reload` +
  `cd frontend && npm run dev -- --port 3001`. Config auto-loads from `.env`
  (gitignored; template in `.env.example`).
  Local admin: `admin@hotel.mn` / `Admin123!` (via `create_admin.py`).

---

## 4. Immediate Next Step — ⏸ Development PAUSED → 🚀 Production Deployment

Feature development is **paused**. The next action is **deploying the
Next.js frontend to Vercel** (root directory: `frontend/`).

Known deployment prerequisites the next session must handle:

1. **`NEXT_PUBLIC_API_URL`** must point at a *publicly reachable* backend —
   the API currently runs only on localhost:8010. Either deploy the FastAPI
   backend first (Railway/Fly/Render + managed Postgres & Redis) or accept
   a preview-only frontend until it exists.
2. **Backend CORS**: `CORS_ALLOW_ORIGINS` must include the Vercel domain(s);
   the production fail-fast guard **refuses `http://` origins and wildcards**
   in `APP_ENV=production`.
3. **Production fail-fast**: the backend will *refuse to boot* in
   `APP_ENV=production` with any dev-default secret, `GOV_USE_MOCKS=true`,
   or `QPAY_USE_MOCKS=true` — real values required (see `.env.example`).
4. **Uploads are local-disk** (`static/uploads/`) — fine single-node; move
   to S3/GCS behind the same `{"url": ...}` contract when scaling.
5. WebSockets (`/ws/...`) are same-origin-agnostic but need `wss://` in prod.

---

## 5. New Chat Prompt (copy-paste to start the next session)

```
Act as a Senior Software Architect with deep DevOps experience. You are
continuing work on a production-ready B2B2C Hotel Booking Marketplace.

CONTEXT — read `project_handoff.md` in the repo root first. Summary: the
monorepo has a FastAPI backend (`app/`, PostgreSQL 16 + RLS multi-tenant
realms, Redis, QPay webhook payments, 21-test E2E suite — all green) and a
Next.js 15 frontend (`frontend/`, builds with zero errors). All work is
merged to `main`. Development is paused.

YOUR TASK — Production Deployment, starting with the frontend:
1. Deploy the Next.js frontend (`frontend/` directory) to Vercel:
   set the Root Directory to `frontend`, framework preset Next.js, and
   configure the `NEXT_PUBLIC_API_URL` environment variable.
2. Before assuming anything works, verify the deployment constraints in
   section 4 of project_handoff.md — especially that NEXT_PUBLIC_API_URL
   needs a publicly reachable backend (currently localhost-only), and that
   the backend's production fail-fast guard requires real secrets, https
   CORS origins, and mocks disabled.
3. Propose the backend hosting plan (FastAPI + managed Postgres with RLS
   support + Redis) so the frontend has a real API to talk to, then wire
   CORS + env vars end-to-end.
4. Verify every step with real commands/output rather than assumptions,
   flag anything that contradicts the handoff, and push config changes via
   git with clear commit messages.

Work step by step, confirm destructive/billing-relevant actions with me
first, and keep the security posture (RLS realms, no plaintext РД, escrow
integrity) intact throughout.
```
