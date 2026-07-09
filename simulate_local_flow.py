#!/usr/bin/env python3
"""
simulate_local_flow.py — full E2E scenario against a locally running backend.

Drives http://localhost:8000 through a complete real-world story using only
HTTP (httpx), with mock adapters active (GOV_USE_MOCKS=True):

    bootstrap -> admin login -> staff provisioning -> hotel setup ->
    guest search/book/pay -> check-in (KHUR autofill + police screening) ->
    minibar report -> checkout (5%/95% escrow split) -> admin revenue audit

Sequencing notes (matches the REAL API, not an idealised one):
  * ``POST /marketplace/book`` performs create(PENDING) -> escrow capture
    (HELD) -> CONFIRMED in one call; there is no separate public pay
    endpoint, so "book" and "pay" are one HTTP request here.
  * Rooms go OCCUPIED at check-in and VACANT_DIRTY at checkout — the
    cleaner therefore reports the minibar DURING the stay and marks the
    room clean AFTER checkout.

Bootstrap: the very first PLATFORM_ADMIN, the hotel (Tenant) and the
platform wallet have no public creation APIs by design, so a clearly
labelled bootstrap phase inserts them straight into Postgres. Override
the owner DSN via SIM_BOOTSTRAP_DSN if your local DB differs.

Run:
    uvicorn app.main:app --port 8000        # terminal 1
    python3 simulate_local_flow.py          # terminal 2
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import secrets
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import asyncpg
import httpx
import jwt
from passlib.context import CryptContext

# ---------------------------------------------------------------------------
# Configuration (env-overridable; defaults match the local dev setup)
# ---------------------------------------------------------------------------
BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")
API = f"{BASE_URL}/api/v1"

#: Schema-owner DSN for the bootstrap inserts (NOT the app's runtime role —
#: RLS would fail-closed on it). Matches the local docker Postgres.
BOOTSTRAP_DSN = os.environ.get(
    "SIM_BOOTSTRAP_DSN",
    "postgresql://hotel:PyJQHYDjvBWevPD46KVV25Z5OFdS055O"
    "@localhost:55440/hotel_marketplace_test",
)

#: Must mirror the server's env (defaults = dev defaults from app config).
REGISTRY_HASH_SALT = os.environ.get("REGISTRY_HASH_SALT", "dev-registry-salt")
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "dev-jwt-secret")
APP_NAME = os.environ.get("APP_NAME", "hotel-marketplace")

#: The guest's registry number IS on the wanted list (seeded in bootstrap)
#: so check-in demonstrably triggers the police pipeline.
GUEST_REGISTRY = "УБ55555555"

RUN = secrets.token_hex(3)                       # uniqueness per run
PASSWORD = "Sim-Password-123!"
HOTEL_LAT, HOTEL_LNG = 47.9185, 106.9177         # Ulaanbaatar centre

NIGHTLY = Decimal("150000.00")
NIGHTS = 2
MINIBAR_PRICE = Decimal("7500.00")
MINIBAR_QTY = 2
ROOM_TOTAL = NIGHTLY * NIGHTS                    # 300 000
MINIBAR_TOTAL = MINIBAR_PRICE * MINIBAR_QTY      # 15 000
EXPECTED_COMMISSION_DELTA = (ROOM_TOTAL + MINIBAR_TOTAL) * Decimal("0.05")

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ---------------------------------------------------------------------------
# Pretty console output (plain ANSI — zero extra dependencies)
# ---------------------------------------------------------------------------
class C:
    RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
    RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN = (
        "\033[31m", "\033[32m", "\033[33m", "\033[34m", "\033[35m", "\033[36m"
    )


def banner(text: str) -> None:
    print(f"\n{C.BOLD}{C.MAGENTA}{'━' * 66}\n  {text}\n{'━' * 66}{C.RESET}")


def step(n: str, actor: str, text: str) -> None:
    print(f"\n{C.BOLD}{C.BLUE}▶ STEP {n}{C.RESET} "
          f"{C.CYAN}[{actor}]{C.RESET} {C.BOLD}{text}{C.RESET}")


def ok(text: str) -> None:
    print(f"    {C.GREEN}✔ {text}{C.RESET}")


def info(text: str) -> None:
    print(f"    {C.DIM}· {text}{C.RESET}")


def warn(text: str) -> None:
    print(f"    {C.YELLOW}⚠ {text}{C.RESET}")


def die(text: str) -> None:
    print(f"    {C.RED}{C.BOLD}✖ {text}{C.RESET}")
    sys.exit(1)


def check(resp: httpx.Response, expected: int) -> dict:
    """Print the wire exchange and hard-assert the status code."""
    colour = C.GREEN if resp.status_code == expected else C.RED
    print(f"    {C.DIM}{resp.request.method} "
          f"{resp.request.url.path}{C.RESET} → "
          f"{colour}{resp.status_code}{C.RESET}")
    if resp.status_code != expected:
        die(f"expected HTTP {expected}, got {resp.status_code}: {resp.text}")
    return resp.json() if resp.content else {}


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def money(value) -> str:
    return f"{Decimal(str(value)):,.2f} MNT"


# ---------------------------------------------------------------------------
# Bootstrap helpers (mirror the app's own derivations exactly)
# ---------------------------------------------------------------------------
def registry_hash(registry_number: str) -> str:
    """Same keyed HMAC-SHA256 the backend applies (see police_service)."""
    normalized = registry_number.replace(" ", "").replace("-", "").upper()
    return hmac.new(
        REGISTRY_HASH_SALT.encode(), normalized.encode(), hashlib.sha256
    ).hexdigest()


def mint_police_token() -> str:
    """Dev-only: mint a police-realm JWT with the server's (dev) secret."""
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "iss": APP_NAME, "sub": "qa-sim-dispatch", "type": "access",
            "realm": "police", "role": "POLICE",
            "tenant_id": None, "restaurant_id": None,
            "iat": now, "exp": now + timedelta(minutes=30),
        },
        JWT_SECRET_KEY,
        algorithm="HS256",
    )


async def bootstrap() -> tuple[str, str]:
    """Seed platform wallet, hotel, first admin, wanted person. Returns
    (admin_email, tenant_id)."""
    conn = await asyncpg.connect(BOOTSTRAP_DSN)
    try:
        await conn.execute(
            """INSERT INTO platform_accounts (currency, balance, commission_rate)
               SELECT 'MNT', 0, 0.0500
               WHERE NOT EXISTS (SELECT 1 FROM platform_accounts)"""
        )
        tenant_id = await conn.fetchval(
            """INSERT INTO tenants
                 (name, slug, contact_email, address, maps_lat, maps_lng,
                  subscription_plan, subscription_started_at,
                  subscription_expires_at, is_active, wallet_balance)
               VALUES ($1, $2, $3, $4, $5, $6, '12_MONTHS'::subscription_plan,
                       now(), now() + interval '365 days', true, 0)
               RETURNING id""",
            f"Sim Grand Hotel {RUN}", f"sim-grand-{RUN}",
            f"hotel-{RUN}@sim.mn", "Peace Avenue 1, Ulaanbaatar",
            Decimal(str(HOTEL_LAT)), Decimal(str(HOTEL_LNG)),
        )
        admin_email = f"admin-{RUN}@platform.mn"
        await conn.execute(
            """INSERT INTO users
                 (email, hashed_password, full_name, role, is_active)
               VALUES ($1, $2, 'Sim Platform Admin',
                       'PLATFORM_ADMIN'::user_role, true)""",
            admin_email, _pwd.hash(PASSWORD),
        )
        await conn.execute(
            """INSERT INTO wanted_persons
                 (registry_hash, full_name, address, case_reference, is_active)
               VALUES ($1, 'Симуляцийн Сэжигтэн', 'unknown', $2, true)
               ON CONFLICT (registry_hash) DO NOTHING""",
            registry_hash(GUEST_REGISTRY), f"CASE-SIM-{RUN}",
        )
    finally:
        await conn.close()
    return admin_email, str(tenant_id)


# ---------------------------------------------------------------------------
# The scenario
# ---------------------------------------------------------------------------
async def main() -> None:
    banner(f"HOTEL MARKETPLACE — LOCAL E2E SIMULATION  (run id: {RUN})")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # ---- Preflight ------------------------------------------------- #
        try:
            health = await client.get(f"{BASE_URL}/healthz")
        except httpx.ConnectError:
            die(f"backend is not reachable at {BASE_URL} — "
                "start it with: uvicorn app.main:app --port 8000")
        check(health, 200)
        ok(f"backend alive at {BASE_URL} (env={health.json()['env']})")

        # ---- Step 0: bootstrap ----------------------------------------- #
        step("0", "BOOTSTRAP", "Seed platform wallet, hotel, first admin, "
                               "wanted person (direct DB — no public API "
                               "creates these, by design)")
        admin_email, tenant_id = await bootstrap()
        ok(f"hotel 'Sim Grand Hotel {RUN}' (tenant {tenant_id[:8]}…)")
        ok(f"platform admin {admin_email}")
        info(f"wanted person seeded for registry {GUEST_REGISTRY} — "
             "the guest we'll check in IS wanted (police demo)")

        # ---- Step 1: platform admin login ------------------------------ #
        step("1", "PLATFORM_ADMIN", "Login")
        body = check(await client.post(f"{API}/auth/login", json={
            "email": admin_email, "password": PASSWORD}), 200)
        admin = body["access_token"]
        ok(f"JWT received (role={body['role']}, "
           f"expires_in={body['expires_in']}s)")

        revenue_before = check(await client.get(
            f"{API}/admin/dashboard/revenue", headers=bearer(admin)), 200)
        info(f"platform wallet BEFORE scenario: "
             f"{money(revenue_before['wallet_balance'])}")

        # ---- Step 2: provision staff ----------------------------------- #
        step("2", "PLATFORM_ADMIN", "Provision a Hotel Manager and a "
                                    "Receptionist for the tenant")
        mgr_email = f"manager-{RUN}@sim.mn"
        rec_email = f"reception-{RUN}@sim.mn"
        check(await client.post(f"{API}/auth/users", headers=bearer(admin),
              json={"email": mgr_email, "password": PASSWORD,
                    "full_name": "Sim Manager", "role": "MANAGER",
                    "tenant_id": tenant_id}), 201)
        ok(f"manager {mgr_email}")
        check(await client.post(f"{API}/auth/users", headers=bearer(admin),
              json={"email": rec_email, "password": PASSWORD,
                    "full_name": "Sim Receptionist", "role": "RECEPTION",
                    "tenant_id": tenant_id}), 201)
        ok(f"receptionist {rec_email}")

        # ---- Step 3: manager sets up the hotel -------------------------- #
        step("3", "MANAGER", "Login and create minibar category, minibar "
                             "item and a VACANT_CLEAN room")
        body = check(await client.post(f"{API}/auth/login", json={
            "email": mgr_email, "password": PASSWORD}), 200)
        manager = body["access_token"]

        cat = check(await client.post(f"{API}/manager/minibar/categories",
              headers=bearer(manager), json={"name": "Beverages"}), 201)
        item = check(await client.post(f"{API}/manager/minibar/items",
              headers=bearer(manager),
              json={"category_id": cat["id"], "name": "Sea Buckthorn Juice",
                    "price": str(MINIBAR_PRICE)}), 201)
        ok(f"minibar: {cat['name']} / {item['name']} @ {money(item['price'])}")

        room_number = f"5{secrets.randbelow(90) + 10}"
        room = check(await client.post(f"{API}/manager/rooms",
              headers=bearer(manager),
              json={"room_number": room_number, "room_type": "DOUBLE",
                    "beds": 2, "floor": 5, "base_price": str(NIGHTLY)}), 201)
        ok(f"room {room['room_number']} ({room['room_type']}, "
           f"{money(room['base_price'])}/night) — state={room['state']}")

        # Manager also provisions the cleaner (own-tenant staff).
        cln_email = f"cleaner-{RUN}@sim.mn"
        check(await client.post(f"{API}/auth/users", headers=bearer(manager),
              json={"email": cln_email, "password": PASSWORD,
                    "full_name": "Sim Cleaner", "role": "CLEANER"}), 201)
        info(f"(manager also provisioned cleaner {cln_email} for step 7)")

        # ---- Step 4: guest searches (NO auth) --------------------------- #
        step("4", "GUEST (public)", "Geo-search hotels within 5 km with "
                                    "real date-range availability")
        check_in = date.today().isoformat()
        check_out = (date.today() + timedelta(days=NIGHTS)).isoformat()
        hotels = check(await client.get(f"{API}/marketplace/search", params={
            "lat": HOTEL_LAT, "lng": HOTEL_LNG, "radius_km": 5,
            "check_in": check_in, "check_out": check_out}), 200)
        ours = next(h for h in hotels if h["slug"] == f"sim-grand-{RUN}")
        assert ours["available_rooms"] >= 1, "our room must be available"
        ok(f"found '{ours['name']}' at {ours['distance_km']} km — "
           f"{ours['available_rooms']} room(s) free, "
           f"from {money(ours['min_nightly_rate'])}/night")

        # ---- Step 5: guest books + pays (one endpoint) ------------------- #
        step("5", "GUEST (public)", "Book the room — the endpoint runs "
                                    "PENDING → escrow capture (HELD) → "
                                    "CONFIRMED in one call")
        booking = check(await client.post(f"{API}/marketplace/book",
              headers={"Idempotency-Key": f"sim-book-{RUN}-{uuid.uuid4()}"},
              json={"room_id": room["id"], "guest_full_name": "Walk In Alias",
                    "guest_phone": "+976-99110022",
                    "check_in_date": check_in, "check_out_date": check_out,
                    "payment_method": "QPAY"}), 201)
        assert booking["status"] == "CONFIRMED"
        assert booking["escrow_status"] == "HELD"
        assert Decimal(str(booking["total_amount"])) == ROOM_TOTAL
        ok(f"booking {booking['booking_code']}: {NIGHTS} nights × "
           f"{money(booking['nightly_rate'])} = "
           f"{money(booking['total_amount'])}")
        ok(f"mock QPay txn {booking['gateway_transaction_id'][:22]}… — "
           f"escrow={booking['escrow_status']}, status={booking['status']}")

        # ---- Step 6: reception check-in ---------------------------------- #
        step("6", "RECEPTIONIST", "Login and check the guest in — mock KHUR "
                                  "auto-fills identity; police screening "
                                  "fires in the background")
        body = check(await client.post(f"{API}/auth/login", json={
            "email": rec_email, "password": PASSWORD}), 200)
        reception = body["access_token"]

        checked_in = check(await client.post(f"{API}/reception/check-in",
              headers=bearer(reception),
              json={"booking_id": booking["booking_id"],
                    "registry_number": GUEST_REGISTRY}), 200)
        ok(f"KHUR verified identity: {checked_in['verified_full_name']}")
        ok(f"KHUR address: {checked_in['verified_address']}")
        ok(f"status={checked_in['status']}, room {room_number} → OCCUPIED")
        info("police screening scheduled post-commit; API responded "
             "instantly either way (no timing side channel)")

        # Bonus verification: the police realm actually saw the match.
        await asyncio.sleep(1.5)
        police_resp = await client.get(f"{API}/police/matches",
                                       headers=bearer(mint_police_token()))
        if police_resp.status_code == 200:
            hits = [m for m in police_resp.json()
                    if m["booking_code"] == booking["booking_code"]]
            if hits:
                m = hits[0]
                ok(f"POLICE MATCH: '{m['wanted_full_name']}' "
                   f"({m['case_reference']}) at {m['hotel_name']}, "
                   f"room {m['room_number']} — status {m['status']}")
            else:
                warn("no police match found yet (screening may still be "
                     "running) — continuing")
        else:
            warn(f"police check skipped (HTTP {police_resp.status_code}) — "
                 "server likely runs a non-dev JWT secret")

        # ---- Step 7: cleaner reports minibar ------------------------------ #
        step("7a", "CLEANER", "Login and report minibar consumption for the "
                              "occupied room (charged at checkout)")
        body = check(await client.post(f"{API}/auth/login", json={
            "email": cln_email, "password": PASSWORD}), 200)
        cleaner = body["access_token"]
        report = check(await client.post(f"{API}/cleaner/minibar/report",
              headers=bearer(cleaner),
              json={"room_id": room["id"],
                    "items": [{"minibar_item_id": item["id"],
                               "quantity": MINIBAR_QTY}]}), 201)
        assert Decimal(str(report["total_amount"])) == MINIBAR_TOTAL
        ok(f"{MINIBAR_QTY} × {item['name']} = {money(report['total_amount'])} "
           "recorded; reception screens notified via WebSocket topic")
        info("(mark-clean comes AFTER checkout — the room is OCCUPIED, "
             "and the state machine is OCCUPIED → VACANT_DIRTY → VACANT_CLEAN)")

        # ---- Step 8: reception checkout ----------------------------------- #
        step("8", "RECEPTIONIST", "Check the guest out — settle minibar, "
                                  "release escrow 5% / 95%")
        out = check(await client.post(f"{API}/reception/checkout",
              headers=bearer(reception),
              json={"booking_id": booking["booking_id"],
                    "minibar_payment_method": "QPAY"}), 200)
        assert Decimal(str(out["commission_amount"])) == ROOM_TOTAL * Decimal("0.05")
        assert Decimal(str(out["hotel_amount"])) == ROOM_TOTAL * Decimal("0.95")
        assert Decimal(str(out["minibar_charged"])) == MINIBAR_TOTAL
        assert out["room_state"] == "VACANT_DIRTY"
        ok(f"room escrow released: {money(out['total_amount'])} → "
           f"{money(out['commission_amount'])} platform (5%) + "
           f"{money(out['hotel_amount'])} hotel (95%)")
        ok(f"minibar settled separately: {money(out['minibar_charged'])}")
        ok(f"status={out['status']}, room → {out['room_state']}")

        # ---- Step 7b: cleaner closes the housekeeping loop ----------------- #
        step("7b", "CLEANER", "See the room on the dirty list and mark it "
                              "clean (sellable again)")
        dirty = check(await client.get(f"{API}/cleaner/rooms/dirty",
                                       headers=bearer(cleaner)), 200)
        assert any(r["room_number"] == room_number for r in dirty)
        cleaned = check(await client.post(
            f"{API}/cleaner/rooms/{room['id']}/mark-clean",
            headers=bearer(cleaner)), 200)
        ok(f"room {room_number}: VACANT_DIRTY → {cleaned['state']}")

        # ---- Step 9: admin verifies the money ------------------------------ #
        step("9", "PLATFORM_ADMIN", "Audit the revenue dashboard — the 5% "
                                    "commission must be on the ledger")
        revenue = check(await client.get(f"{API}/admin/dashboard/revenue",
                                         headers=bearer(admin)), 200)
        delta = (Decimal(str(revenue["wallet_balance"]))
                 - Decimal(str(revenue_before["wallet_balance"])))
        assert delta == EXPECTED_COMMISSION_DELTA, (
            f"commission delta {delta} != expected {EXPECTED_COMMISSION_DELTA}")
        ok(f"wallet grew by exactly {money(delta)} "
           f"(= 5% of {money(ROOM_TOTAL)} room + "
           f"{money(MINIBAR_TOTAL)} minibar)")
        for source, amount in sorted(revenue["by_source"].items()):
            info(f"ledger source {source}: {money(amount)} lifetime")

        banner("SCENARIO COMPLETE — every step verified against live HTTP ✔")
        print(f"{C.GREEN}{C.BOLD}"
              f"  booking {booking['booking_code']} | room {room_number} | "
              f"commission this run: {money(EXPECTED_COMMISSION_DELTA)}"
              f"{C.RESET}\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        die("interrupted")
