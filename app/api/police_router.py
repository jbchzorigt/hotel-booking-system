"""
Police dashboard API — the only HTTP surface of the police realm.

Every endpoint requires a police-realm token (``require_police``) and the
injected session is the **police engine** (``police_runtime`` DB role) via
``get_scoped_session`` — the same connection identity as the background
matcher. Hotel and platform credentials get 403 here, and even if the
gate were removed, their database roles hold no grants on these tables.

The read model joins the minimum dispatch context the grants allow:
wanted person, hotel (name/address/geo), room number, booking code.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.dependencies.auth import AuthContext, ScopedSession, require_police
from app.models.domain import (
    Booking,
    PoliceMatch,
    PoliceMatchStatus,
    Room,
    Tenant,
    WantedPerson,
)

router = APIRouter(prefix="/police", tags=["police"])

PoliceCtx = Annotated[AuthContext, Depends(require_police)]


# ===========================================================================
# Schemas
# ===========================================================================
class MatchOut(BaseModel):
    match_id: uuid.UUID
    status: PoliceMatchStatus
    matched_at: datetime
    # -- wanted person ---------------------------------------------------- #
    wanted_full_name: str
    case_reference: str | None
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
    #: CONFIRMED = genuine hit (dispatch follows); DISMISSED = false positive.
    resolution: Literal["CONFIRMED", "DISMISSED"]
    note: str | None = Field(default=None, max_length=2000)


class ResolveResponse(BaseModel):
    match_id: uuid.UUID
    status: PoliceMatchStatus
    reviewed_at: datetime


# ===========================================================================
# Endpoints
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
    """Match feed for the dispatch dashboard, newest first."""
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


@router.post("/matches/{match_id}/resolve", response_model=ResolveResponse)
async def resolve_match(
    match_id: uuid.UUID,
    body: ResolveRequest,
    ctx: PoliceCtx,
    session: ScopedSession,
) -> ResolveResponse:
    """
    Close a PENDING_REVIEW match as CONFIRMED (genuine) or DISMISSED
    (false positive). Resolution is terminal and single-shot: a second
    attempt returns 409 so two dispatchers cannot silently overwrite
    each other's judgement.
    """
    match = await session.get(PoliceMatch, match_id, with_for_update=True)
    if match is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "match not found")
    if match.status != PoliceMatchStatus.PENDING_REVIEW:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"match already resolved as {match.status.value}",
        )

    match.status = PoliceMatchStatus(body.resolution)
    match.reviewed_at = datetime.now(timezone.utc)
    match.review_note = body.note

    return ResolveResponse(
        match_id=match.id, status=match.status, reviewed_at=match.reviewed_at
    )
