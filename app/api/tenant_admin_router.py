"""
Tenant provisioning — the manual, admin-only birth of a hotel.

This is the deliberate counterpart of the "Secure Lead Capture" flow:
the ONLY way a ``Tenant`` comes into existence is a PLATFORM_ADMIN calling
these endpoints after manually verifying the hotel (police-realm
integration makes self-serve tenancy an unacceptable attack surface).

Flow:
    lead (contact_requests, status NEW/CONTACTED)
        └─ POST /admin/tenants                (optionally links the lead:
           creates the Tenant AND flips the lead to CONVERTED in ONE
           transaction — lead state and tenant existence cannot disagree)
              └─ POST /admin/tenants/{id}/users
                 first HOTEL_ADMIN, strictly bound to that tenant; they
                 then provision their own staff via POST /auth/users.

Both endpoints run under the platform RLS identity (``get_scoped_session``
for a PLATFORM_ADMIN token) — the ``tenant_isolation`` policies' WITH CHECK
accepts platform-admin writes, every other identity is rejected by the
database itself.
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.passwords import hash_password
from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    ContactRequest,
    ContactRequestStatus,
    SubscriptionPlan,
    Tenant,
    User,
    UserRole,
)

router = APIRouter(prefix="/admin/tenants", tags=["platform-admin"])

AdminCtx = Annotated[AuthContext, Depends(require_roles(UserRole.PLATFORM_ADMIN))]


def _slugify(name: str) -> str | None:
    """ASCII slug from a hotel name; None when nothing survives (e.g. a
    fully Cyrillic name) — the caller then falls back to a random slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or None


# ===========================================================================
# Schemas
# ===========================================================================
class TenantCreate(BaseModel):
    """Everything a functioning hotel needs on day one. ``name`` is the
    only identity field; the rest powers search (geo), guest contact and
    the subscription clock."""

    name: str = Field(min_length=2, max_length=160)
    #: URL-safe marketplace identifier; derived from ``name`` if omitted.
    slug: str | None = Field(
        default=None, min_length=3, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]+$"
    )
    contact_email: EmailStr
    contact_phone: str | None = Field(default=None, max_length=32)
    address: str | None = Field(default=None, max_length=500)
    maps_lat: Decimal = Field(ge=-90, le=90)
    maps_lng: Decimal = Field(ge=-180, le=180)
    subscription_plan: SubscriptionPlan = SubscriptionPlan.MONTHS_12
    #: Optional link back to the sales lead: marks it CONVERTED atomically
    #: with the tenant creation.
    contact_request_id: uuid.UUID | None = None


class TenantCreated(BaseModel):
    tenant_id: uuid.UUID
    name: str
    slug: str
    subscription_plan: SubscriptionPlan
    subscription_expires_at: datetime
    converted_lead_id: uuid.UUID | None


class HotelAdminCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=64)
    full_name: str = Field(min_length=2, max_length=255)
    phone: str | None = Field(default=None, max_length=32)


class HotelAdminCreated(BaseModel):
    user_id: uuid.UUID
    email: str
    full_name: str
    role: UserRole
    tenant_id: uuid.UUID


# ===========================================================================
# POST /admin/tenants
# ===========================================================================
@router.post("", response_model=TenantCreated, status_code=status.HTTP_201_CREATED)
async def create_tenant(
    body: TenantCreate, ctx: AdminCtx, session: ScopedSession
) -> TenantCreated:
    """Provision a verified hotel. Subscription starts now and runs for
    the plan's length (3/6/9/12 months)."""
    # -- Resolve the slug ------------------------------------------------ #
    if body.slug is not None:
        slug = body.slug
        if (
            await session.execute(select(Tenant.id).where(Tenant.slug == slug))
        ).scalar_one_or_none() is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"slug {slug!r} is already taken"
            )
    else:
        slug = _slugify(body.name) or f"hotel-{secrets.token_hex(3)}"
        if (
            await session.execute(select(Tenant.id).where(Tenant.slug == slug))
        ).scalar_one_or_none() is not None:
            slug = f"{slug[:70]}-{secrets.token_hex(3)}"  # derived: de-dupe

    # -- Optional lead linkage (same transaction, locked) ----------------- #
    lead: ContactRequest | None = None
    if body.contact_request_id is not None:
        lead = await session.get(
            ContactRequest, body.contact_request_id, with_for_update=True
        )
        if lead is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "contact request not found"
            )
        if lead.status == ContactRequestStatus.CONVERTED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this lead is already CONVERTED — a tenant exists for it",
            )

    now = datetime.now(timezone.utc)
    tenant = Tenant(
        name=body.name,
        slug=slug,
        contact_email=body.contact_email,
        contact_phone=body.contact_phone,
        address=body.address,
        maps_lat=body.maps_lat,
        maps_lng=body.maps_lng,
        subscription_plan=body.subscription_plan,
        subscription_started_at=now,
        # Calendar months ~ plan.months * 30d is wrong for billing; use
        # 365/12 to stay within a day of the true calendar length.
        subscription_expires_at=now
        + timedelta(days=round(body.subscription_plan.months * 365 / 12)),
    )
    session.add(tenant)
    try:
        await session.flush()
    except IntegrityError as exc:  # slug race between check and insert
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"slug {slug!r} is already taken"
        ) from exc

    if lead is not None:
        lead.status = ContactRequestStatus.CONVERTED  # atomic with tenant

    return TenantCreated(
        tenant_id=tenant.id,
        name=tenant.name,
        slug=tenant.slug,
        subscription_plan=tenant.subscription_plan,
        subscription_expires_at=tenant.subscription_expires_at,
        converted_lead_id=lead.id if lead is not None else None,
    )


# ===========================================================================
# POST /admin/tenants/{tenant_id}/users
# ===========================================================================
@router.post(
    "/{tenant_id}/users",
    response_model=HotelAdminCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_hotel_admin(
    tenant_id: uuid.UUID,
    body: HotelAdminCreate,
    ctx: AdminCtx,
    session: ScopedSession,
) -> HotelAdminCreated:
    """
    Create the hotel's first HOTEL_ADMIN, bound to the PATH tenant — the
    role is not caller-selectable on this endpoint by design. Further
    staff (reception/cleaners/managers) is the hotel admin's own job via
    ``POST /auth/users``.
    """
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tenant not found")
    if not tenant.is_active:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "tenant is deactivated — reactivate first"
        )

    user = User(
        email=body.email.lower(),
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        phone=body.phone,
        role=UserRole.HOTEL_ADMIN,
        tenant_id=tenant.id,      # strictly the path tenant, never the body
        restaurant_id=None,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a user with this email already exists"
        ) from exc

    return HotelAdminCreated(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        tenant_id=tenant.id,
    )
