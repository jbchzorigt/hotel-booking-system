"""End-to-end integration test for Phases 1-3 against a scratch DB."""
import asyncio
import concurrent.futures
import json
import os
import sys
import uuid
import warnings
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

warnings.filterwarnings("ignore")

# This machine has another project exposing an `app` package on PYTHONPATH —
# make absolutely sure we import THIS project.
sys.path.insert(0, "/Users/zorigtgantumur/Documents/Work/Final Project")

# --- Environment MUST be set before any app import --------------------------
os.environ.update(
    APP_ENV="local",
    POSTGRES_HOST="localhost",
    POSTGRES_PORT="55440",
    POSTGRES_USER="app_runtime",
    POSTGRES_PASSWORD="CHANGE_ME_IN_PRODUCTION",
    POSTGRES_DB="hotel_marketplace_test",
    POSTGRES_POLICE_USER="police_runtime",
    POSTGRES_POLICE_PASSWORD="CHANGE_ME_IN_PRODUCTION",
)

import redis as sync_redis
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.database import get_engine
from app.core.redis import get_redis
from app.core.security import create_access_token
from app.models.domain import (
    Booking, BookingStatus, EscrowStatus, MinibarConsumption, PlatformAccount,
    PlatformLedgerEntry, PoliceMatch, Room, RoomState, RoomType,
    SubscriptionPlan, Tenant, User, UserRole, WantedPerson,
)
from app.services.payment_escrow_service import (
    EscrowService, InvalidEscrowStateError, PaymentMethod,
)
from app.services.police_service import compute_registry_hash

OWNER_URL = ("postgresql+asyncpg://hotel:PyJQHYDjvBWevPD46KVV25Z5OFdS055O"
             "@localhost:55440/hotel_marketplace_test")
REGISTRY = "УБ11111111"
IDS: dict[str, uuid.UUID] = {}


def ok(msg): print(f"  ✔ {msg}")


# ============================================================================
# Phase A — seed (owner conn, bypasses RLS) + escrow capture + idempotency
# ============================================================================
async def phase_a():
    owner = create_async_engine(OWNER_URL)
    from sqlalchemy.ext.asyncio import async_sessionmaker
    now = datetime.now(timezone.utc)
    async with async_sessionmaker(owner, expire_on_commit=False)() as s:
        s.add(PlatformAccount(currency="MNT", balance=Decimal("0.00"),
                              commission_rate=Decimal("0.0500")))
        ta = Tenant(name="Blue Sky Hotel", slug="blue-sky", contact_email="a@a.mn",
                    maps_lat=Decimal("47.918530"), maps_lng=Decimal("106.917701"),
                    address="Peace Avenue 17, Ulaanbaatar",
                    subscription_plan=SubscriptionPlan.MONTHS_12,
                    subscription_started_at=now,
                    subscription_expires_at=now + timedelta(days=365))
        tb = Tenant(name="Steppe Inn", slug="steppe-inn", contact_email="b@b.mn",
                    maps_lat=Decimal("47.900000"), maps_lng=Decimal("106.900000"),
                    subscription_plan=SubscriptionPlan.MONTHS_3,
                    subscription_started_at=now,
                    subscription_expires_at=now + timedelta(days=90))
        s.add_all([ta, tb]); await s.flush()
        cleaner = User(email="cleaner@bluesky.mn", hashed_password="x",
                       full_name="Cleaner One", role=UserRole.CLEANER,
                       tenant_id=ta.id)
        room = Room(tenant_id=ta.id, room_number="101", room_type=RoomType.DOUBLE,
                    beds=2, floor=1, base_price=Decimal("100000.00"))
        s.add_all([cleaner, room]); await s.flush()
        booking = Booking(
            tenant_id=ta.id, room_id=room.id, code="BK-TEST01",
            guest_full_name="Unverified Alias", guest_phone="+976-99112233",
            check_in_date=date.today(), check_out_date=date.today() + timedelta(days=2),
            status=BookingStatus.CONFIRMED,
            nightly_rate=Decimal("100000.00"), total_amount=Decimal("200000.00"),
            commission_rate=Decimal("0.0500"), commission_amount=Decimal("0.00"))
        s.add(booking)
        s.add(WantedPerson(registry_hash=compute_registry_hash(REGISTRY),
                           full_name="Мөнх Болд", address="unknown",
                           case_reference="CASE-42"))
        await s.commit()
        IDS.update(tenant_a=ta.id, tenant_b=tb.id, cleaner=cleaner.id,
                   room=room.id, booking=booking.id)
    await owner.dispose()
    ok("seeded: platform account, 2 hotels, room, CONFIRMED booking, wanted person")

    # Escrow capture through the real service (platform-realm RLS session)
    escrow = EscrowService()
    key = f"cap-{uuid.uuid4()}"
    r1 = await escrow.pay_booking(IDS["booking"], method=PaymentMethod.QPAY,
                                  idempotency_key=key)
    assert r1.escrow_status == "HELD" and r1.amount == "200000.00"
    r2 = await escrow.pay_booking(IDS["booking"], method=PaymentMethod.QPAY,
                                  idempotency_key=key)   # replay
    assert r2 == r1, "replay must return the identical cached receipt"
    try:
        await escrow.pay_booking(IDS["booking"], method=PaymentMethod.QPAY,
                                 idempotency_key=f"cap-{uuid.uuid4()}")
        sys.exit("FAIL: double capture with fresh key was allowed")
    except InvalidEscrowStateError:
        pass
    ok("escrow capture: HELD, idempotent replay, fresh-key double-charge blocked")

    # Free loop-bound resources before the TestClient's event loop takes over
    await get_engine().dispose()
    await get_redis().aclose()

asyncio.run(phase_a())

# ============================================================================
# Phase B — API flows through TestClient (real DB, real RLS, real Redis)
# ============================================================================
from fastapi.testclient import TestClient
from app.main import app

def tok(role, tenant=None, restaurant=None, realm="app", sub=None):
    return create_access_token(subject=str(sub or uuid.uuid4()), role=role,
                               realm=realm, tenant_id=tenant, restaurant_id=restaurant)

def hdr(t): return {"Authorization": f"Bearer {t}"}

mgr_a  = tok("MANAGER", tenant=IDS["tenant_a"])
mgr_b  = tok("MANAGER", tenant=IDS["tenant_b"])
rec_a  = tok("RECEPTION", tenant=IDS["tenant_a"])
rec_b  = tok("RECEPTION", tenant=IDS["tenant_b"])
cln_a  = tok("CLEANER", tenant=IDS["tenant_a"], sub=IDS["cleaner"])
police = tok("POLICE", realm="police", sub="dispatch-01")

pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
def ws_recv(ws, timeout):
    return pool.submit(ws.receive_text).result(timeout=timeout)

with TestClient(app) as client:
    import time; time.sleep(0.7)  # let the pub/sub relay finish subscribing

    print("Phase B — API flows")
    # -- Manager CRUD (tenant A) ------------------------------------------- #
    r = client.post("/api/v1/manager/minibar/categories",
                    json={"name": "Beverages"}, headers=hdr(mgr_a))
    assert r.status_code == 201, r.text
    cat_id = r.json()["id"]
    r = client.post("/api/v1/manager/minibar/items",
                    json={"category_id": cat_id, "name": "Chinggis Beer 0.5L",
                          "price": "8000.00"}, headers=hdr(mgr_a))
    assert r.status_code == 201, r.text
    item_id = r.json()["id"]
    r = client.post("/api/v1/manager/minibar/categories",
                    json={"name": "Beverages"}, headers=hdr(mgr_a))
    assert r.status_code == 409, "duplicate category must 409"
    ok("manager CRUD: category + item created; duplicate -> 409")

    # -- RLS isolation through the API ------------------------------------- #
    assert client.get("/api/v1/manager/rooms", headers=hdr(mgr_b)).json() == []
    assert client.get("/api/v1/manager/minibar/items", headers=hdr(mgr_b)).json() == []
    r = client.post("/api/v1/reception/check-in",
                    json={"booking_id": str(IDS["booking"]),
                          "registry_number": REGISTRY}, headers=hdr(rec_b))
    assert r.status_code == 404, "hotel B must not even learn booking A exists"
    ok("RLS: hotel B sees zero of hotel A's rooms/items; foreign booking -> 404")

    # -- Real-time listeners BEFORE the events fire ------------------------- #
    with client.websocket_connect(f"/ws/police/alerts?token={police}") as ws_pol, \
         client.websocket_connect(f"/ws/reception?token={rec_a}") as ws_rec:
        time.sleep(0.3)

        # -- Check-in: KHUR autofill + background police screening ---------- #
        r = client.post("/api/v1/reception/check-in",
                        json={"booking_id": str(IDS["booking"]),
                              "registry_number": REGISTRY}, headers=hdr(rec_a))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "CHECKED_IN" and body["room_number"] == "101"
        assert body["verified_full_name"] and body["verified_address"]
        ok(f"check-in: KHUR verified '{body['verified_full_name']}', room OCCUPIED")

        alert = json.loads(ws_recv(ws_pol, 15))
        assert alert["type"] == "POLICE_MATCH_ALERT"
        assert alert["wanted_full_name"] == "Мөнх Болд"
        assert alert["case_reference"] == "CASE-42"
        assert alert["room_number"] == "101"
        assert alert["hotel_name"] == "Blue Sky Hotel"
        assert abs(alert["hotel_maps_lat"] - 47.918530) < 1e-6
        ok("police WS alert delivered: wanted person + hotel geo + room number")

        # -- Cleaner minibar report + reception broadcast -------------------- #
        r = client.post("/api/v1/cleaner/minibar/report",
                        json={"room_id": str(IDS["room"]),
                              "items": [{"minibar_item_id": item_id, "quantity": 2}]},
                        headers=hdr(cln_a))
        assert r.status_code == 201, r.text
        assert Decimal(r.json()["total_amount"]) == Decimal("16000.00")
        note = json.loads(ws_recv(ws_rec, 10))
        assert note["type"] == "MINIBAR_REPORT" and note["room_number"] == "101"
        assert Decimal(note["total_amount"]) == Decimal("16000.00")
        ok("minibar report: 2 x 8000 recorded; reception WS notified in real time")

    # -- Dirty rooms list is empty while occupied --------------------------- #
    assert client.get("/api/v1/cleaner/rooms/dirty", headers=hdr(cln_a)).json() == []

    # -- Checkout: minibar settle + escrow release --------------------------- #
    r = client.post("/api/v1/reception/checkout",
                    json={"booking_id": str(IDS["booking"])}, headers=hdr(rec_a))
    assert r.status_code == 200, r.text
    out = r.json()
    assert Decimal(str(out["total_amount"])) == Decimal("200000.00")
    assert Decimal(str(out["commission_amount"])) == Decimal("10000.00")
    assert Decimal(str(out["hotel_amount"])) == Decimal("190000.00")
    assert Decimal(str(out["minibar_charged"])) == Decimal("16000.00")
    assert out["room_state"] == "VACANT_DIRTY"
    ok("checkout: 200000 -> 10000 platform / 190000 hotel; minibar 16000 settled")

    r = client.post("/api/v1/reception/checkout",
                    json={"booking_id": str(IDS["booking"])}, headers=hdr(rec_a))
    assert r.status_code == 409, "second checkout must be rejected"
    ok("checkout replay -> 409 (escrow already RELEASED, no double credit)")

    # -- Cleaner flow closes the loop ---------------------------------------- #
    dirty = client.get("/api/v1/cleaner/rooms/dirty", headers=hdr(cln_a)).json()
    assert [d["room_number"] for d in dirty] == ["101"]
    assert "base_price" not in dirty[0] and "guest" not in json.dumps(dirty)
    r = client.post(f"/api/v1/cleaner/rooms/{IDS['room']}/mark-clean",
                    headers=hdr(cln_a))
    assert r.status_code == 200 and r.json()["state"] == "VACANT_CLEAN"
    ok("housekeeping: dirty list (PII-free) -> mark-clean -> sellable again")

    # ======================================================================
    # Phase D — public marketplace: geo search, booking, food orders
    # ======================================================================
    print("Phase D — marketplace & food orders")
    ci = (date.today() + timedelta(days=3)).isoformat()
    co = (date.today() + timedelta(days=5)).isoformat()

    # -- Public geo search (NO auth header at all) -------------------------
    r = client.get("/api/v1/marketplace/search",
                   params={"lat": 47.918, "lng": 106.917, "radius_km": 5,
                           "check_in": ci, "check_out": co})
    assert r.status_code == 200, r.text
    hotels = {h["slug"]: h for h in r.json()}
    assert "blue-sky" in hotels and "steppe-inn" in hotels
    assert hotels["blue-sky"]["available_rooms"] == 1
    assert Decimal(str(hotels["blue-sky"]["min_nightly_rate"])) == Decimal("100000.00")
    assert hotels["blue-sky"]["distance_km"] < 1.0
    assert hotels["steppe-inn"]["available_rooms"] == 0
    ok("geo search: both hotels in radius, availability + min rate + distance")

    # -- Guest books room 101 ----------------------------------------------
    payload = {"room_id": str(IDS["room"]), "guest_full_name": "Second Guest",
               "guest_phone": "+976-88112233", "check_in_date": ci,
               "check_out_date": co, "payment_method": "QPAY"}
    r = client.post("/api/v1/marketplace/book", json=payload,
                    headers={"Idempotency-Key": f"book-{uuid.uuid4()}"})
    assert r.status_code == 201, r.text
    b2 = r.json()
    assert b2["status"] == "CONFIRMED" and b2["escrow_status"] == "HELD"
    assert Decimal(str(b2["total_amount"])) == Decimal("200000.00")
    r = client.post("/api/v1/marketplace/book", json=payload,
                    headers={"Idempotency-Key": f"book-{uuid.uuid4()}"})
    assert r.status_code == 409, "GiST exclusion must reject the overlap"
    r = client.get("/api/v1/marketplace/search",
                   params={"lat": 47.918, "lng": 106.917, "radius_km": 5,
                           "check_in": ci, "check_out": co})
    assert {h["slug"]: h for h in r.json()}["blue-sky"]["available_rooms"] == 0
    ok("booking: paid + CONFIRMED; overlap -> 409; availability drops to 0")

    # -- Restaurant: manager registers, owner manages menu ------------------
    r = client.post("/api/v1/manager/restaurants",
                    json={"name": "Modern Nomads", "phone": "+976-70110011"},
                    headers=hdr(mgr_a))
    assert r.status_code == 201, r.text
    rest_id = r.json()["id"]
    owner = tok("RESTAURANT_OWNER", restaurant=uuid.UUID(rest_id))
    r = client.post("/api/v1/restaurant/menu-items",
                    json={"name": "Khuushuur", "category": "Mains",
                          "price": "5000.00"}, headers=hdr(owner))
    assert r.status_code == 201, r.text
    food_id = r.json()["id"]
    assert client.patch(f"/api/v1/restaurant/menu-items/{food_id}",
                        json={"description": "Fried meat pastry"},
                        headers=hdr(owner)).status_code == 200
    stranger = tok("RESTAURANT_OWNER", restaurant=uuid.uuid4())
    assert client.get("/api/v1/restaurant/menu-items",
                      headers=hdr(stranger)).json() == []
    assert client.patch(f"/api/v1/restaurant/menu-items/{food_id}",
                        json={"price": "1.00"},
                        headers=hdr(stranger)).status_code == 404
    r = client.get(f"/api/v1/marketplace/restaurants/{rest_id}/menu")  # public
    assert r.status_code == 200 and r.json()["items"][0]["name"] == "Khuushuur"
    ok("restaurant menu: owner CRUD isolated by RLS; public menu readable")

    # -- Second guest checks in, orders food to the room ---------------------
    r = client.post("/api/v1/reception/check-in",
                    json={"booking_id": b2["booking_id"],
                          "registry_number": "АА22222222"}, headers=hdr(rec_a))
    assert r.status_code == 200, r.text

    with client.websocket_connect(f"/ws/restaurant/orders?token={owner}") as ws_own:
        time.sleep(0.3)
        r = client.post("/api/v1/marketplace/order",
                        json={"booking_code": b2["booking_code"],
                              "restaurant_id": rest_id,
                              "items": [{"food_item_id": food_id, "quantity": 3}]},
                        headers={"Idempotency-Key": f"food-{uuid.uuid4()}"})
        assert r.status_code == 201, r.text
        o = r.json()
        assert Decimal(str(o["total_amount"])) == Decimal("15000.00")
        assert o["escrow_status"] == "HELD" and o["room_number"] == "101"
        kitchen = json.loads(ws_recv(ws_own, 10))
        assert kitchen["type"] == "NEW_FOOD_ORDER"
        assert kitchen["room_number"] == "101"
        assert Decimal(kitchen["total_amount"]) == Decimal("15000.00")
    ok("food order: 3 x 5000 escrow HELD; kitchen WS alerted after payment")

    # -- Owner fulfils; DELIVERED releases the 95% ---------------------------
    oid = o["order_id"]
    for st in ("ACCEPTED", "PREPARING", "DELIVERED"):
        r = client.patch(f"/api/v1/restaurant/orders/{oid}/status",
                         json={"status": st}, headers=hdr(owner))
        assert r.status_code == 200, r.text
    assert r.json()["escrow_status"] == "RELEASED"
    assert client.patch(f"/api/v1/restaurant/orders/{oid}/status",
                        json={"status": "ACCEPTED"},
                        headers=hdr(owner)).status_code == 409
    ok("fulfilment: PLACED->ACCEPTED->PREPARING->DELIVERED; illegal jump 409")

    # ======================================================================
    # Phase E — platform admin dashboards + Excel export
    # ======================================================================
    print("Phase E — platform admin")
    admin = tok("PLATFORM_ADMIN")
    assert client.get("/api/v1/admin/dashboard/revenue",
                      headers=hdr(mgr_a)).status_code == 403
    r = client.get("/api/v1/admin/dashboard/revenue", headers=hdr(admin))
    assert r.status_code == 200, r.text
    d = r.json()
    assert Decimal(str(d["wallet_balance"])) == Decimal("11550.00")
    assert Decimal(str(d["total_commission_collected"])) == Decimal("11550.00")
    assert set(d["by_source"]) == {"BOOKING_COMMISSION", "MINIBAR_COMMISSION",
                                   "FOOD_ORDER_COMMISSION"}
    ok("revenue dashboard: 11550 = 10000 booking + 800 minibar + 750 food")

    top = client.get("/api/v1/admin/dashboard/top-rooms", headers=hdr(admin)).json()
    assert top[0]["room_number"] == "101" and top[0]["demand"] == 2
    assert Decimal(str(top[0]["gross_revenue"])) == Decimal("400000.00")
    ok("top-rooms: room 101 leads (2 bookings, 400000 gross)")

    r = client.get("/api/v1/admin/export/revenue", headers=hdr(admin))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert "attachment" in r.headers["content-disposition"]
    from openpyxl import load_workbook
    import io as _io
    wb = load_workbook(_io.BytesIO(r.content))
    assert wb.sheetnames == ["Monthly Revenue", "Minibar Statistics"]
    ws1 = wb["Monthly Revenue"]
    sources = {ws1.cell(row=i, column=2).value for i in range(2, ws1.max_row)}
    assert {"BOOKING_COMMISSION", "MINIBAR_COMMISSION",
            "FOOD_ORDER_COMMISSION"} <= sources
    ws2 = wb["Minibar Statistics"]
    assert ws2.cell(row=2, column=2).value == "Chinggis Beer 0.5L"
    assert ws2.cell(row=2, column=3).value == 2
    ok("xlsx export: styled 2-sheet workbook, ledger + minibar stats verified")

    # ======================================================================
    # Phase F — real auth (provision + login) and the police dashboard API
    # ======================================================================
    print("Phase F — auth & police dashboard")
    # Manager provisions a receptionist in their own hotel
    r = client.post("/api/v1/auth/users",
                    json={"email": "Reception2@BlueSky.mn",
                          "password": "S3cure-Front-Desk!",
                          "full_name": "Front Desk Two", "role": "RECEPTION"},
                    headers=hdr(mgr_a))
    assert r.status_code == 201, r.text
    assert r.json()["email"] == "reception2@bluesky.mn"      # normalised
    assert r.json()["tenant_id"] == str(IDS["tenant_a"])     # token wins
    r = client.post("/api/v1/auth/users",
                    json={"email": "reception2@bluesky.mn",
                          "password": "S3cure-Front-Desk!",
                          "full_name": "Dup", "role": "RECEPTION"},
                    headers=hdr(mgr_a))
    assert r.status_code == 409, "duplicate email must 409"
    r = client.post("/api/v1/auth/users",
                    json={"email": "evil@x.mn", "password": "Whatever123!",
                          "full_name": "Evil", "role": "PLATFORM_ADMIN"},
                    headers=hdr(mgr_a))
    assert r.status_code == 403, "manager must not mint platform admins"
    ok("provisioning: manager creates own-tenant staff; escalation -> 403")

    # Login: bcrypt verify, wrong password rejected identically
    assert client.post("/api/v1/auth/login",
                       json={"email": "reception2@bluesky.mn",
                             "password": "wrong-password-1"}).status_code == 401
    assert client.post("/api/v1/auth/login",
                       json={"email": "ghost@nowhere.mn",
                             "password": "wrong-password-1"}).status_code == 401
    r = client.post("/api/v1/auth/login",
                    json={"email": "reception2@bluesky.mn",
                          "password": "S3cure-Front-Desk!"})
    assert r.status_code == 200, r.text
    login = r.json()
    assert login["role"] == "RECEPTION" and login["token_type"] == "bearer"
    # The minted token really works end-to-end (auth + RBAC + RLS session)
    r = client.post("/api/v1/reception/checkout",
                    json={"booking_id": str(uuid.uuid4())},
                    headers=hdr(login["access_token"]))
    assert r.status_code == 404, r.text   # authenticated, authorised, no row
    ok("login: bcrypt verified, uniform 401s, minted token drives real endpoint")

    # Police dashboard API (police realm session via get_scoped_session)
    assert client.get("/api/v1/police/matches",
                      headers=hdr(mgr_a)).status_code == 403
    r = client.get("/api/v1/police/matches", headers=hdr(police))
    assert r.status_code == 200, r.text
    matches = r.json()
    assert len(matches) == 1
    m = matches[0]
    assert m["wanted_full_name"] == "Мөнх Болд" and m["room_number"] == "101"
    assert m["hotel_name"] == "Blue Sky Hotel" and m["status"] == "PENDING_REVIEW"
    r = client.post(f"/api/v1/police/matches/{m['match_id']}/resolve",
                    json={"resolution": "CONFIRMED", "note": "Unit dispatched"},
                    headers=hdr(police))
    assert r.status_code == 200 and r.json()["status"] == "CONFIRMED"
    r = client.post(f"/api/v1/police/matches/{m['match_id']}/resolve",
                    json={"resolution": "DISMISSED"}, headers=hdr(police))
    assert r.status_code == 409, "double resolution must 409"
    ok("police API: dispatch feed + single-shot resolution; hotel token 403")

pool.shutdown(wait=False)

# ============================================================================
# Phase C — ledger & wallet truth (owner conn, bypasses RLS)
# ============================================================================
async def phase_c():
    print("Phase C — financial & police ground truth")
    owner = create_async_engine(OWNER_URL)
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from app.models.domain import Restaurant
    async with async_sessionmaker(owner)() as s:
        platform = (await s.execute(select(PlatformAccount))).scalar_one()
        assert platform.balance == Decimal("11550.00"), platform.balance
        hotel = await s.get(Tenant, IDS["tenant_a"])
        assert hotel.wallet_balance == Decimal("205200.00"), hotel.wallet_balance
        resto = (await s.execute(select(Restaurant))).scalar_one()
        assert resto.wallet_balance == Decimal("14250.00"), resto.wallet_balance
        entries = (await s.execute(
            select(PlatformLedgerEntry).order_by(PlatformLedgerEntry.created_at)
        )).scalars().all()
        assert [e.source_type.value for e in entries] == \
            ["MINIBAR_COMMISSION", "BOOKING_COMMISSION", "FOOD_ORDER_COMMISSION"]
        assert entries[-1].balance_after == Decimal("11550.00")
        ok("wallet math: platform 11550, hotel 205200, restaurant 14250 — "
           "every ledger entry reconciles")

        booking = await s.get(Booking, IDS["booking"])
        assert booking.status == BookingStatus.CHECKED_OUT
        assert booking.escrow_status == EscrowStatus.RELEASED
        assert booking.commission_amount == Decimal("10000.00")
        assert booking.guest_registry_hash == compute_registry_hash(REGISTRY)
        bookings_total = (await s.execute(
            select(func.count()).select_from(Booking))).scalar_one()
        assert bookings_total == 2  # second guest's stay, still HELD
        match = (await s.execute(select(PoliceMatch))).scalar_one()
        # Phase F resolved it via the dashboard API.
        assert match.booking_id == booking.id and match.status.value == "CONFIRMED"
        assert match.review_note == "Unit dispatched"
        settled = (await s.execute(select(func.count()).select_from(MinibarConsumption)
                                   .where(MinibarConsumption.is_settled))).scalar_one()
        assert settled == 1
        ok("state machine: guest1 CHECKED_OUT/RELEASED, guest2 HELD; still "
           "exactly 1 police match (guest2 not wanted)")
    await owner.dispose()

asyncio.run(phase_c())

# ============================================================================
# Phase G — janitor sweep (own loop; free the app loop's pooled resources)
# ============================================================================
async def phase_g():
    print("Phase G — janitor")
    from app.core.database import get_engine as _get_engine
    from app.core.redis import get_redis as _get_redis
    await _get_engine().dispose()   # drop connections bound to the app loop
    await _get_redis().aclose()
    from app.services.janitor_service import JanitorService
    from sqlalchemy.ext.asyncio import async_sessionmaker

    owner = create_async_engine(OWNER_URL)
    def _pending(code, days_in, days_out, total):
        return Booking(
            tenant_id=IDS["tenant_a"], room_id=IDS["room"], code=code,
            guest_full_name="Cart Guest", guest_phone="+976-00000000",
            check_in_date=date.today() + timedelta(days=days_in),
            check_out_date=date.today() + timedelta(days=days_out),
            status=BookingStatus.PENDING,
            nightly_rate=Decimal("100000.00"), total_amount=Decimal(total),
            commission_rate=Decimal("0.0500"),
            commission_amount=Decimal("0.00"))

    async with async_sessionmaker(owner, expire_on_commit=False)() as s:
        stale, fresh = _pending("BK-STALE1", 20, 22, "200000.00"), \
                       _pending("BK-FRESH1", 25, 26, "100000.00")
        s.add_all([stale, fresh]); await s.flush()
        # Backdate ONLY the stale one past the 15-minute TTL.
        await s.execute(text(
            "UPDATE bookings SET created_at = now() - interval '20 minutes' "
            "WHERE code = 'BK-STALE1'"))
        await s.commit()
        stale_id, fresh_id = stale.id, fresh.id

    result = await JanitorService().sweep_once()
    assert result["skipped"] is False
    assert result["bookings_cancelled"] == 1, result

    async with async_sessionmaker(owner)() as s:
        assert (await s.get(Booking, stale_id)).status == BookingStatus.CANCELLED
        assert (await s.get(Booking, fresh_id)).status == BookingStatus.PENDING
        # The GiST slot really is freed: rebooking the stale dates works now.
        s.add(_pending("BK-RETRY1", 20, 22, "200000.00"))
        await s.commit()
    await owner.dispose()
    await _get_engine().dispose()   # connections the sweep opened in THIS loop
    ok("janitor: stale PENDING cancelled (money-safe predicate), fresh kept, "
       "GiST dates freed for rebooking")

asyncio.run(phase_g())
print("\nALL INTEGRATION TESTS PASSED")
