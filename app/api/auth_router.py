"""
Authentication & staff provisioning.

Login trust model
=================
``POST /login`` is the auth BOOTSTRAP: it runs before any identity exists,
so it cannot use ``get_scoped_session``. The email lookup crosses tenant
boundaries by necessity (the user doesn't tell us their hotel) and runs
inside ``platform_session()`` — a deliberate, narrowly-scoped system
operation, exactly like escrow settlement.

Anti-enumeration: unknown email, wrong password and disabled account all
return the same 401 body, and unknown emails still pay a full bcrypt
verification (``DUMMY_HASH``) so timing doesn't leak account existence.

Provisioning matrix (``POST /users``)
=====================================
    MANAGER / HOTEL_ADMIN  -> RECEPTION | CLEANER | MANAGER, always in
                              THEIR OWN hotel (scope ids in the body are
                              ignored — the token decides).
    PLATFORM_ADMIN         -> any role; HOTEL_ADMIN/staff need a valid
                              tenant_id, RESTAURANT_OWNER a restaurant_id.

The DB's ``role_realm_consistency`` check plus the RLS ``WITH CHECK`` on
``users`` back this matrix up — the endpoint cannot be tricked into
writing an identity the database considers impossible.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import platform_session
from app.core.passwords import DUMMY_HASH, hash_password, verify_password
from app.core.security import create_access_token
from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import Restaurant, Tenant, User, UserRole

router = APIRouter(prefix="/auth", tags=["auth"])

_HOTEL_STAFF_ROLES = frozenset(
    {UserRole.RECEPTION, UserRole.CLEANER, UserRole.MANAGER}
)

ProvisionerCtx = Annotated[
    AuthContext,
    Depends(
        require_roles(UserRole.MANAGER, UserRole.HOTEL_ADMIN, UserRole.PLATFORM_ADMIN)
    ),
]


# ===========================================================================
# Schemas
# ===========================================================================
class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=64)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    role: UserRole


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=64)
    full_name: str = Field(min_length=2, max_length=255)
    phone: str | None = Field(default=None, max_length=32)
    role: UserRole
    #: Honoured ONLY for PLATFORM_ADMIN callers; hotel callers always
    #: provision into their own tenant.
    tenant_id: uuid.UUID | None = None
    restaurant_id: uuid.UUID | None = None


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: UserRole
    tenant_id: uuid.UUID | None
    restaurant_id: uuid.UUID | None
    is_active: bool

    model_config = {"from_attributes": True}


# ===========================================================================
# POST /login
# ===========================================================================
@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest) -> TokenResponse:
    """Verify credentials and mint an access token for the principal."""
    invalid = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "invalid email or password",  # deliberately identical for all causes
        headers={"WWW-Authenticate": "Bearer"},
    )

    async with platform_session() as session:
        user = (
            await session.execute(
                select(User).where(User.email == body.email.lower())
            )
        ).scalar_one_or_none()

        # ALWAYS verify against some hash — unknown emails must cost the
        # same bcrypt work as real ones (no timing oracle).
        password_ok = verify_password(
            body.password, user.hashed_password if user else DUMMY_HASH
        )
        if user is None or not password_ok or not user.is_active:
            raise invalid

        user.last_login_at = datetime.now(timezone.utc)
        token = create_access_token(
            subject=str(user.id),
            role=user.role.value,
            tenant_id=user.tenant_id,
            restaurant_id=user.restaurant_id,
        )
        role = user.role

    return TokenResponse(
        access_token=token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        role=role,
    )


# ===========================================================================
# GET /users — team roster
# ===========================================================================
@router.get("/users", response_model=list[UserOut])
async def list_users(
    ctx: ProvisionerCtx, session: ScopedSession
) -> list[UserOut]:
    """The caller's team. RLS does the scoping: hotel admins/managers see
    their own tenant's staff, platform admins see everyone."""
    users = (
        (
            await session.execute(
                select(User).order_by(User.role, User.full_name)
            )
        )
        .scalars()
        .all()
    )
    return [UserOut.model_validate(user) for user in users]


# ===========================================================================
# POST /users — staff provisioning
# ===========================================================================
@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate, ctx: ProvisionerCtx, session: ScopedSession
) -> UserOut:
    """Provision a staff account per the matrix in the module docstring."""
    if ctx.role == UserRole.PLATFORM_ADMIN.value:
        tenant_id, restaurant_id = body.tenant_id, body.restaurant_id
        if body.role == UserRole.PLATFORM_ADMIN:
            if tenant_id or restaurant_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "platform admins carry no tenant/restaurant scope",
                )
        elif body.role == UserRole.RESTAURANT_OWNER:
            if not restaurant_id or tenant_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "restaurant owners need restaurant_id (and no tenant_id)",
                )
            if await session.get(Restaurant, restaurant_id) is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "restaurant not found"
                )
        else:  # hotel admin or hotel staff
            if not tenant_id or restaurant_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "hotel roles need tenant_id (and no restaurant_id)",
                )
            if await session.get(Tenant, tenant_id) is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "hotel not found")
    else:
        # Hotel managers/admins: own hotel only, operational roles only.
        if body.role not in _HOTEL_STAFF_ROLES:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "hotel managers may only provision reception/cleaner/manager staff",
            )
        tenant_id, restaurant_id = ctx.tenant_id, None  # token wins over body

    user = User(
        email=body.email.lower(),
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        phone=body.phone,
        role=body.role,
        tenant_id=tenant_id,
        restaurant_id=restaurant_id,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a user with this email already exists"
        ) from exc
    return UserOut.model_validate(user)
