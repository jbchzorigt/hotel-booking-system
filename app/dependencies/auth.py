"""
Authentication & authorization dependencies.

The chain every protected endpoint rides on:

    Authorization: Bearer <jwt>
        └─ get_auth_context      decode + consistency-check the token
            ├─ require_roles(…)  RBAC gate (per router / per endpoint)
            └─ get_scoped_session
                 opens the RLS-pinned DB session matching the principal:
                   PLATFORM_ADMIN  -> platform_session()
                   hotel staff     -> tenant_session(role, tenant_id)
                   RESTAURANT_OWNER-> tenant_session(role, restaurant_id=…)
                   police realm    -> police_session()  (WebSocket/API only
                                      via require_police, never implicitly)

Defense in depth — three independent layers must all agree before a row
is visible: (1) this module's RBAC checks, (2) the identity GUCs pinned
onto the transaction, (3) the PostgreSQL RLS policies evaluating those
GUCs. Compromising the router layer alone leaks nothing.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Annotated, AsyncIterator, Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import (
    marketplace_session,
    platform_session,
    police_session,
    tenant_session,
)
from app.core.security import TokenClaims, TokenError, decode_access_token
from app.models.domain import UserRole

_bearer = HTTPBearer(auto_error=False)

#: Role string used by police-realm principals (not a ``UserRole`` — police
#: users are not rows in the hotel-realm ``users`` table).
POLICE_ROLE = "POLICE"

_HOTEL_STAFF_ROLES = frozenset(
    {
        UserRole.HOTEL_ADMIN.value,
        UserRole.MANAGER.value,
        UserRole.RECEPTION.value,
        UserRole.CLEANER.value,
    }
)


@dataclass(frozen=True, slots=True)
class AuthContext:
    """The authenticated principal, as trusted by every downstream layer."""

    user_id: uuid.UUID | None       # None for police principals
    realm: str                      # "app" | "police"
    role: str                       # UserRole value or POLICE_ROLE
    tenant_id: uuid.UUID | None
    restaurant_id: uuid.UUID | None


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _context_from_claims(claims: TokenClaims) -> AuthContext:
    """
    Build an AuthContext, enforcing the same role/realm/id consistency the
    database's ``role_realm_consistency`` constraint enforces on rows.
    An internally inconsistent token is treated as forged.
    """
    role, realm = claims.role, claims.realm

    if realm == "police":
        if role != POLICE_ROLE or claims.tenant_id or claims.restaurant_id:
            raise TokenError("inconsistent police-realm claims")
        # Carry the officer id when the subject is a real officer UUID (from
        # POST /police/login) — needed for audit attribution. Externally
        # minted tokens may use non-UUID subjects; those degrade to None.
        try:
            officer_id: uuid.UUID | None = uuid.UUID(claims.subject)
        except (ValueError, TypeError):
            officer_id = None
        return AuthContext(
            user_id=officer_id, realm=realm, role=role,
            tenant_id=None, restaurant_id=None,
        )

    if role == UserRole.PLATFORM_ADMIN.value:
        if claims.tenant_id or claims.restaurant_id:
            raise TokenError("platform admin token must not carry scope ids")
    elif role == UserRole.GUEST.value:
        # B2C marketplace guest: app realm, no tenant/restaurant scope.
        if claims.tenant_id or claims.restaurant_id:
            raise TokenError("guest token must not carry scope ids")
    elif role in _HOTEL_STAFF_ROLES:
        if not claims.tenant_id or claims.restaurant_id:
            raise TokenError("hotel-staff token must carry tenant_id only")
    elif role == UserRole.RESTAURANT_OWNER.value:
        if not claims.restaurant_id or claims.tenant_id:
            raise TokenError("restaurant-owner token must carry restaurant_id only")
    else:
        raise TokenError(f"unknown role {role!r}")

    try:
        user_id = uuid.UUID(claims.subject)
    except ValueError as exc:
        raise TokenError("subject is not a valid user id") from exc

    return AuthContext(
        user_id=user_id,
        realm=realm,
        role=role,
        tenant_id=claims.tenant_id,
        restaurant_id=claims.restaurant_id,
    )


# ---------------------------------------------------------------------------
# HTTP dependencies
# ---------------------------------------------------------------------------
async def get_auth_context(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer)
    ],
) -> AuthContext:
    """Authenticate the request or fail with 401."""
    if credentials is None:
        raise _unauthorized("missing bearer token")
    try:
        return _context_from_claims(decode_access_token(credentials.credentials))
    except TokenError as exc:
        raise _unauthorized(str(exc)) from exc


def require_roles(*roles: UserRole) -> Callable[..., AuthContext]:
    """
    Dependency factory: pass only app-realm principals holding one of
    ``roles``; returns the AuthContext so endpoints get it in one hop.
    """
    allowed = frozenset(r.value for r in roles)

    def _gate(
        ctx: Annotated[AuthContext, Depends(get_auth_context)],
    ) -> AuthContext:
        if ctx.realm != "app" or ctx.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires one of roles: {', '.join(sorted(allowed))}",
            )
        return ctx

    return _gate


def require_police(
    ctx: Annotated[AuthContext, Depends(get_auth_context)],
) -> AuthContext:
    """Gate for police-realm endpoints."""
    if ctx.realm != "police":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="police realm credentials required",
        )
    return ctx


async def get_scoped_session(
    ctx: Annotated[AuthContext, Depends(get_auth_context)],
) -> AsyncIterator[AsyncSession]:
    """
    Yield ONE transaction pinned (via RLS GUCs) to the caller's identity.
    Commits when the endpoint returns; rolls back if it raises.

    Endpoints that need a post-commit side effect (police screening,
    WebSocket broadcasts) schedule it with ``BackgroundTasks`` — FastAPI
    runs dependency teardown (our COMMIT) before background tasks fire.
    """
    if ctx.realm == "police":
        async with police_session() as session:
            yield session
        return

    if ctx.role == UserRole.PLATFORM_ADMIN.value:
        async with platform_session() as session:
            yield session
        return

    async with tenant_session(
        user_role=ctx.role,
        tenant_id=ctx.tenant_id,
        restaurant_id=ctx.restaurant_id,
    ) as session:
        yield session


#: Convenience annotation used across all routers.
ScopedSession = Annotated[AsyncSession, Depends(get_scoped_session)]


async def get_marketplace_session() -> AsyncIterator[AsyncSession]:
    """
    PUBLIC (unauthenticated) read-only session for guest discovery
    endpoints. Deliberately NOT derived from a token: the RLS marketplace
    realm is the entire authorization model here — active hotels, active
    rooms, active restaurants, available menu items, nothing else.
    """
    async with marketplace_session() as session:
        yield session


#: Public marketplace reads (search, menus). Never use for writes.
MarketplaceSession = Annotated[AsyncSession, Depends(get_marketplace_session)]


# ---------------------------------------------------------------------------
# WebSocket authentication
# ---------------------------------------------------------------------------
def authenticate_ws_token(token: str | None) -> AuthContext | None:
    """
    Validate a token passed as a WebSocket query parameter
    (``wss://…/ws/reception?token=…``). Returns None instead of raising —
    the WS handshake path closes the socket with a policy-violation code
    rather than mapping exceptions to HTTP statuses.
    """
    if not token:
        return None
    try:
        return _context_from_claims(decode_access_token(token))
    except TokenError:
        return None
