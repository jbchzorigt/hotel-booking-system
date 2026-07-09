"""
Secure lead capture — "Manual Verification / Contact Sales" onboarding.

Threat model
============
Because the platform integrates with the General Police Department, tenant
creation is NEVER self-serve: a hostile actor must not be able to stand up
a "hotel" and start feeding the police pipeline. The public surface is
therefore reduced to exactly one write: a lead with a hotel name, a
contact name and a phone number. Everything downstream (verification,
contract, ``Tenant`` creation, staff provisioning) is a manual
PLATFORM_ADMIN act through the existing admin/auth endpoints.

Abuse controls on the public endpoint:
  * strict field validation (lengths, phone shape) — no free-form blobs;
  * a Redis fixed-window rate limit per client IP (an open POST endpoint
    is otherwise a free DoS of the sales team's inbox);
  * the response echoes nothing back except a reference id — no oracle
    about duplicates or internal state.

Two routers on purpose: the public one mounts under ``/onboarding``, the
admin one under ``/admin/onboarding`` next to the rest of the platform
dashboard, each with its own auth posture.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.core.database import platform_session
from app.core.redis import get_redis
from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import ContactRequest, ContactRequestStatus, UserRole

logger = logging.getLogger("app.onboarding")

public_router = APIRouter(prefix="/onboarding", tags=["onboarding"])
admin_router = APIRouter(prefix="/admin/onboarding", tags=["platform-admin"])

AdminCtx = Annotated[AuthContext, Depends(require_roles(UserRole.PLATFORM_ADMIN))]

#: Fixed-window rate limit for the public endpoint: per source IP per hour.
_RATE_LIMIT_MAX = 5
_RATE_LIMIT_WINDOW_SECONDS = 3600


# ===========================================================================
# Schemas
# ===========================================================================
class ContactRequestCreate(BaseModel):
    hotel_name: str = Field(min_length=2, max_length=160)
    contact_name: str = Field(min_length=2, max_length=160)
    phone: str = Field(min_length=6, max_length=32)

    @field_validator("phone")
    @classmethod
    def _phone_shape(cls, value: str) -> str:
        """Digits with optional +, spaces, hyphens — nothing else."""
        stripped = value.replace(" ", "").replace("-", "")
        core = stripped.removeprefix("+")
        if not core.isdigit() or not (6 <= len(core) <= 15):
            raise ValueError("phone must be 6-15 digits, optionally with +")
        return stripped

    @field_validator("hotel_name", "contact_name")
    @classmethod
    def _no_control_chars(cls, value: str) -> str:
        cleaned = value.strip()
        if any(ord(ch) < 32 for ch in cleaned):
            raise ValueError("control characters are not allowed")
        return cleaned


class ContactRequestReceipt(BaseModel):
    """Deliberately minimal — the public caller learns a reference id and
    nothing else about internal state."""

    request_id: uuid.UUID
    status: ContactRequestStatus


class ContactRequestOut(BaseModel):
    id: uuid.UUID
    hotel_name: str
    contact_name: str
    phone: str
    status: ContactRequestStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class LeadStatusUpdate(BaseModel):
    """Move a lead through the sales pipeline. Enum-validated: anything
    outside NEW/CONTACTED/CONVERTED/REJECTED is a 422 before any DB work."""

    status: ContactRequestStatus


# ===========================================================================
# Rate limiting (public endpoint only)
# ===========================================================================
async def _enforce_rate_limit(request: Request) -> None:
    """
    Fixed-window counter in Redis, keyed by client IP.

    NOTE for deployment: behind a reverse proxy, configure uvicorn with
    ``--proxy-headers --forwarded-allow-ips`` so ``request.client.host``
    reflects the real client, not the proxy.

    Fails OPEN on Redis outage: losing rate limiting briefly is better
    than taking lead capture down with the cache.
    """
    client_ip = request.client.host if request.client else "unknown"
    key = f"rl:onboarding:{client_ip}"
    try:
        redis = get_redis()
        hits = await redis.incr(key)
        if hits == 1:
            await redis.expire(key, _RATE_LIMIT_WINDOW_SECONDS)
    except Exception:  # noqa: BLE001 — availability over enforcement
        logger.exception("rate-limit check failed; allowing request")
        return
    if hits > _RATE_LIMIT_MAX:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too many onboarding requests from this address — "
            "please try again later or call our sales line",
        )


# ===========================================================================
# PUBLIC: POST /onboarding/request
# ===========================================================================
@public_router.post(
    "/request",
    response_model=ContactRequestReceipt,
    status_code=status.HTTP_201_CREATED,
)
async def submit_contact_request(
    body: ContactRequestCreate, request: Request
) -> ContactRequestReceipt:
    """
    Ask to join the marketplace. A platform representative verifies the
    hotel manually and provisions the tenant — there is intentionally no
    self-serve path from this endpoint to a live ``Tenant``.

    Platform-orchestrated write (same pattern as guest bookings): the
    insert runs under the platform session because the anonymous public
    holds no database identity of its own.
    """
    await _enforce_rate_limit(request)

    async with platform_session() as session:
        lead = ContactRequest(
            hotel_name=body.hotel_name,
            contact_name=body.contact_name,
            phone=body.phone,
        )
        session.add(lead)
        await session.flush()
        receipt = ContactRequestReceipt(request_id=lead.id, status=lead.status)

    logger.info("onboarding lead received: %s", receipt.request_id)
    return receipt


# ===========================================================================
# ADMIN: GET /admin/onboarding/requests
# ===========================================================================
@admin_router.get("/requests", response_model=list[ContactRequestOut])
async def list_contact_requests(
    ctx: AdminCtx,
    session: ScopedSession,
    lead_status: Annotated[
        ContactRequestStatus | None, Query(alias="status")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[ContactRequestOut]:
    """
    Sales worklist, newest first. PLATFORM_ADMIN only — the injected
    session carries the platform RLS identity, and the ``platform_only``
    policy on ``contact_requests`` blankets every other realm (a hotel or
    restaurant token could not read these rows even without the RBAC gate).
    """
    query = (
        select(ContactRequest)
        .order_by(ContactRequest.created_at.desc())
        .limit(limit)
    )
    if lead_status is not None:
        query = query.where(ContactRequest.status == lead_status)
    leads = (await session.execute(query)).scalars().all()
    return [ContactRequestOut.model_validate(lead) for lead in leads]


# ===========================================================================
# ADMIN: PATCH /admin/onboarding/requests/{id}/status
# ===========================================================================
@admin_router.patch(
    "/requests/{request_id}/status", response_model=ContactRequestOut
)
async def update_contact_request_status(
    request_id: uuid.UUID,
    body: LeadStatusUpdate,
    ctx: AdminCtx,
    session: ScopedSession,
) -> ContactRequestOut:
    """
    Advance a lead through the pipeline (PLATFORM_ADMIN only).

    Rules:
      * CONVERTED is TERMINAL — it asserts a real ``Tenant`` was created
        for this hotel, and that fact cannot be un-happened by editing a
        lead row. Any transition away from CONVERTED is a 409.
      * Every other move is allowed, including backwards (sales people
        mis-click; an admin tool that cannot undo is a support ticket).
      * Re-asserting the current status is an idempotent no-op (200).

    The row is locked (``FOR UPDATE``) so two admins racing on the same
    lead serialise instead of silently overwriting each other.
    """
    lead = await session.get(ContactRequest, request_id, with_for_update=True)
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "contact request not found")

    if (
        lead.status == ContactRequestStatus.CONVERTED
        and body.status != ContactRequestStatus.CONVERTED
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "lead is CONVERTED (a tenant exists for it) — that is terminal",
        )

    if lead.status != body.status:
        logger.info(
            "lead %s: %s -> %s (by %s)",
            lead.id, lead.status.value, body.status.value, ctx.user_id,
        )
        lead.status = body.status

    return ContactRequestOut.model_validate(lead)
