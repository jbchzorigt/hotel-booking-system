"""
Police realm API — a standalone system with its OWN identity, watchlist
management and audit trail. The only HTTP surface of the police realm.

Isolation contract (unchanged, extended)
=========================================
Every authenticated endpoint requires a police-realm token
(``require_police``) and runs on the **police engine** (``police_runtime``
DB role) via ``get_scoped_session``. Hotel/platform credentials get 403,
and even without the gate their DB roles hold no grants on police tables.

``POST /police/login`` is the ONE exception: like the app's own login it
runs before any identity exists, so it opens ``police_session()`` directly
(realm='police') rather than depending on a token.

Registry-number discipline: the raw РД is verified against KHUR and then
immediately hashed (``compute_registry_hash``). Only the salted hash, the
state-verified name/district/address, and status are stored — never the
plaintext number.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import police_session
from app.core.passwords import DUMMY_HASH, verify_password
from app.core.security import create_access_token
from app.dependencies.auth import POLICE_ROLE, AuthContext, ScopedSession, require_police
from app.models.domain import (
    Booking,
    PoliceAuditLog,
    PoliceMatch,
    PoliceMatchStatus,
    PoliceOfficer,
    PoliceResolutionAction,
    Room,
    Tenant,
    WantedPerson,
    WantedPersonStatus,
)
from app.services import gov_service
from app.services.police_service import compute_registry_hash

router = APIRouter(prefix="/police", tags=["police"])

PoliceCtx = Annotated[AuthContext, Depends(require_police)]


# ===========================================================================
# Schemas — Auth
# ===========================================================================
class PoliceLoginRequest(BaseModel):
    badge_number: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=8, max_length=64)


class PoliceTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    realm: str = "police"
    officer_id: uuid.UUID
    full_name: str


# ===========================================================================
# Schemas — Watchlist
# ===========================================================================
class WatchlistCreateRequest(BaseModel):
    #: Plaintext РД — verified against KHUR, then hashed. NEVER stored raw.
    registry_number: str = Field(min_length=8, max_length=16)
    case_reference: str | None = Field(default=None, max_length=64)


class WantedPersonOut(BaseModel):
    """Redacted watchlist entry — carries the state-verified identity but
    NEVER the registry hash or number."""

    id: uuid.UUID
    full_name: str
    district: str | None
    address: str | None
    case_reference: str | None
    status: WantedPersonStatus
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ===========================================================================
# Schemas — Matches & resolution
# ===========================================================================
class MatchOut(BaseModel):
    match_id: uuid.UUID
    status: PoliceMatchStatus
    matched_at: datetime
    # -- wanted person ---------------------------------------------------- #
    wanted_full_name: str
    case_reference: str | None
    district: str | None
    wanted_status: WantedPersonStatus
    # -- where ------------------------------------------------------------- #
    hotel_name: str
    hotel_address: str | None
    hotel_maps_lat: float
    hotel_maps_lng: float
    room_number: str
    # -- stay --------------------------------------------------------------- #
    booking_code: str
    guest_full_name: str
    check_in_date: str
    check_out_date: str
    # -- review ------------------------------------------------------------- #
    reviewed_at: datetime | None
    review_note: str | None


class ResolveRequest(BaseModel):
    """
    ``action`` drives the resolution; ``resolution`` is a legacy alias kept
    so existing dispatch clients keep working:
        ARRESTED  -> match CONFIRMED + wanted person ARRESTED (de-listed)
        CONFIRMED -> match CONFIRMED (genuine hit, no arrest yet)
        DISMISSED -> match DISMISSED (false positive)
    """

    action: PoliceResolutionAction | None = None
    resolution: PoliceResolutionAction | None = None  # legacy field name
    note: str | None = Field(default=None, max_length=2000)

    def resolved_action(self) -> PoliceResolutionAction:
        chosen = self.action or self.resolution
        if chosen is None:
            raise ValueError("action is required")
        return chosen


class ResolveResponse(BaseModel):
    match_id: uuid.UUID
    status: PoliceMatchStatus
    action: PoliceResolutionAction
    wanted_status: WantedPersonStatus
    reviewed_at: datetime


# ===========================================================================
# Auth — POST /police/login
# ===========================================================================
@router.post("/login", response_model=PoliceTokenResponse)
async def police_login(body: PoliceLoginRequest) -> PoliceTokenResponse:
    """
    Authenticate a police officer and mint a realm='police' JWT.

    Runs in ``police_session()`` (the officer table is police-realm only).
    Anti-enumeration mirrors the app login: unknown badge, wrong password
    and disabled account all return the same 401, and unknown badges still
    pay a full bcrypt verification against ``DUMMY_HASH``.
    """
    invalid = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "invalid badge number or password",
        headers={"WWW-Authenticate": "Bearer"},
    )

    async with police_session() as session:
        officer = (
            await session.execute(
                select(PoliceOfficer).where(
                    PoliceOfficer.badge_number == body.badge_number
                )
            )
        ).scalar_one_or_none()

        password_ok = verify_password(
            body.password, officer.hashed_password if officer else DUMMY_HASH
        )
        if officer is None or not password_ok or not officer.is_active:
            raise invalid

        officer.last_login_at = datetime.now(timezone.utc)
        token = create_access_token(
            subject=str(officer.id), role=POLICE_ROLE, realm="police"
        )
        officer_id, full_name = officer.id, officer.full_name

    return PoliceTokenResponse(
        access_token=token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        officer_id=officer_id,
        full_name=full_name,
    )


# ===========================================================================
# Watchlist — POST/GET /police/watchlist
# ===========================================================================
@router.post(
    "/watchlist",
    response_model=WantedPersonOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_to_watchlist(
    body: WatchlistCreateRequest,
    ctx: PoliceCtx,
    session: ScopedSession,
) -> WantedPersonOut:
    """
    Add a person to the wanted registry.

    1. verify the РД against KHUR and pull the state-held identity;
    2. hash the РД (``compute_registry_hash``) — the raw number is NEVER
       persisted;
    3. store hash + verified name/district/address + status=WANTED.
    """
    try:
        citizen = await gov_service.get_khur_api().fetch_citizen(
            body.registry_number
        )
    except gov_service.InvalidRegistryNumberError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    except gov_service.CitizenNotFoundError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "no citizen record for registry number"
        )
    except gov_service.GovUpstreamError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "state registry unavailable, try again"
        )

    person = WantedPerson(
        registry_hash=compute_registry_hash(body.registry_number),
        full_name=citizen.full_name,
        district=citizen.district,
        address=citizen.address,
        case_reference=body.case_reference,
        status=WantedPersonStatus.WANTED,
        is_active=True,
    )
    session.add(person)
    try:
        await session.flush()
    except IntegrityError as exc:  # duplicate registry_hash (already listed)
        raise HTTPException(
            status.HTTP_409_CONFLICT, "this person is already on the watchlist"
        ) from exc

    # Audit: who added whom (no РД in the log).
    session.add(
        PoliceAuditLog(
            officer_id=ctx.user_id,
            action="WATCHLIST_ADDED",
            target_person_id=person.id,
            note=body.case_reference,
        )
    )
    return WantedPersonOut.model_validate(person)


@router.get("/watchlist", response_model=list[WantedPersonOut])
async def list_watchlist(
    ctx: PoliceCtx,
    session: ScopedSession,
    person_status: Annotated[
        WantedPersonStatus | None, Query(alias="status")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[WantedPersonOut]:
    """All watchlist entries, newest first. Redacted — never the hash."""
    query = (
        select(WantedPerson)
        .order_by(WantedPerson.created_at.desc())
        .limit(limit)
    )
    if person_status is not None:
        query = query.where(WantedPerson.status == person_status)
    persons = (await session.execute(query)).scalars().all()
    return [WantedPersonOut.model_validate(p) for p in persons]


# ===========================================================================
# Matches — GET /police/matches
# ===========================================================================
def _to_match_out(
    match: PoliceMatch,
    wanted: WantedPerson,
    tenant: Tenant,
    room: Room,
    booking: Booking,
) -> MatchOut:
    return MatchOut(
        match_id=match.id,
        status=match.status,
        matched_at=match.matched_at,
        wanted_full_name=wanted.full_name,
        case_reference=wanted.case_reference,
        district=wanted.district,
        wanted_status=wanted.status,
        hotel_name=tenant.name,
        hotel_address=tenant.address,
        hotel_maps_lat=float(tenant.maps_lat),
        hotel_maps_lng=float(tenant.maps_lng),
        room_number=room.room_number,
        booking_code=booking.code,
        guest_full_name=booking.guest_full_name,
        check_in_date=booking.check_in_date.isoformat(),
        check_out_date=booking.check_out_date.isoformat(),
        reviewed_at=match.reviewed_at,
        review_note=match.review_note,
    )


@router.get("/matches", response_model=list[MatchOut])
async def list_matches(
    ctx: PoliceCtx,
    session: ScopedSession,
    match_status: PoliceMatchStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[MatchOut]:
    """Match feed for the dispatch dashboard, newest first — now including
    the wanted person's district alongside hotel + room."""
    query = (
        select(PoliceMatch, WantedPerson, Tenant, Room, Booking)
        .join(WantedPerson, PoliceMatch.wanted_person_id == WantedPerson.id)
        .join(Booking, PoliceMatch.booking_id == Booking.id)
        .join(Room, Booking.room_id == Room.id)
        .join(Tenant, PoliceMatch.tenant_id == Tenant.id)
        .order_by(PoliceMatch.matched_at.desc())
        .limit(limit)
    )
    if match_status is not None:
        query = query.where(PoliceMatch.status == match_status)
    rows = (await session.execute(query)).all()
    return [_to_match_out(*row) for row in rows]


# ===========================================================================
# Resolution — POST /police/matches/{id}/resolve
# ===========================================================================
#: action -> resulting match status. ARRESTED also de-lists the person.
_MATCH_STATUS_FOR_ACTION = {
    PoliceResolutionAction.ARRESTED: PoliceMatchStatus.CONFIRMED,
    PoliceResolutionAction.CONFIRMED: PoliceMatchStatus.CONFIRMED,
    PoliceResolutionAction.DISMISSED: PoliceMatchStatus.DISMISSED,
}


@router.post("/matches/{match_id}/resolve", response_model=ResolveResponse)
async def resolve_match(
    match_id: uuid.UUID,
    body: ResolveRequest,
    ctx: PoliceCtx,
    session: ScopedSession,
) -> ResolveResponse:
    """
    Resolve a PENDING_REVIEW match with an officer action. Single-shot: a
    second attempt returns 409. On ARRESTED the related wanted person is
    marked ARRESTED and de-listed (stops matching). Every resolution writes
    an immutable ``police_audit_logs`` row (officer, action, target, when).
    """
    try:
        action = body.resolved_action()
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))

    match = await session.get(PoliceMatch, match_id, with_for_update=True)
    if match is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "match not found")
    if match.status != PoliceMatchStatus.PENDING_REVIEW:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"match already resolved as {match.status.value}",
        )

    wanted = await session.get(
        WantedPerson, match.wanted_person_id, with_for_update=True
    )

    now = datetime.now(timezone.utc)
    match.status = _MATCH_STATUS_FOR_ACTION[action]
    match.reviewed_at = now
    match.review_note = body.note

    if action == PoliceResolutionAction.ARRESTED and wanted is not None:
        wanted.status = WantedPersonStatus.ARRESTED
        wanted.is_active = False  # stop producing new matches

    session.add(
        PoliceAuditLog(
            officer_id=ctx.user_id,
            action=action.value,
            target_person_id=match.wanted_person_id,
            match_id=match.id,
            note=body.note,
        )
    )

    return ResolveResponse(
        match_id=match.id,
        status=match.status,
        action=action,
        wanted_status=(
            wanted.status if wanted is not None else WantedPersonStatus.WANTED
        ),
        reviewed_at=now,
    )
