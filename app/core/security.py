"""
JWT creation and validation (PyJWT, HS256).

Claim model
===========
Every access token carries the principal's *authorization context*:

    sub            user id (uuid) — or police badge id in the police realm
    realm          "app" | "police"
    role           UserRole value, or "POLICE" for the police realm
    tenant_id      uuid string, only for hotel-staff roles
    restaurant_id  uuid string, only for RESTAURANT_OWNER
    type           "access" (refresh tokens are Phase 4)
    iat / exp      standard timestamps

The dependency layer (``app.dependencies.auth``) re-validates the
role/realm/id consistency rules (mirroring the ``role_realm_consistency``
DB constraint) so a token minted by buggy code still cannot produce an
impossible identity.

Revocation model: access tokens are short-lived (``ACCESS_TOKEN_EXPIRE_
MINUTES``); immediate revocation (Redis denylist keyed by ``jti``) is a
Phase 4 concern and slot-in compatible.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt

from app.core.config import settings


class TokenError(Exception):
    """Token is missing, malformed, expired or has an invalid signature."""


@dataclass(frozen=True, slots=True)
class TokenClaims:
    """Validated, typed view of a decoded access token."""

    subject: str
    realm: str                      # "app" | "police"
    role: str                       # UserRole value or "POLICE"
    tenant_id: uuid.UUID | None
    restaurant_id: uuid.UUID | None


def create_access_token(
    *,
    subject: str,
    role: str,
    realm: str = "app",
    tenant_id: uuid.UUID | None = None,
    restaurant_id: uuid.UUID | None = None,
    expires_minutes: int | None = None,
) -> str:
    """Mint a signed access token for one principal."""
    now = datetime.now(timezone.utc)
    lifetime = timedelta(
        minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload: dict[str, object] = {
        "iss": settings.APP_NAME,
        "sub": subject,
        "type": "access",
        "realm": realm,
        "role": role,
        "tenant_id": str(tenant_id) if tenant_id else None,
        "restaurant_id": str(restaurant_id) if restaurant_id else None,
        "iat": now,
        "exp": now + lifetime,
    }
    return jwt.encode(
        payload,
        settings.JWT_SECRET_KEY.get_secret_value(),
        algorithm=settings.JWT_ALGORITHM,
    )


def decode_access_token(token: str) -> TokenClaims:
    """
    Verify signature/expiry and return typed claims.

    Raises:
        TokenError: on any validation failure — callers translate to 401.
    """
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY.get_secret_value(),
            algorithms=[settings.JWT_ALGORITHM],  # pinned: no alg-confusion
            issuer=settings.APP_NAME,
            options={"require": ["exp", "iat", "sub", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(f"invalid token: {exc}") from exc

    if payload.get("type") != "access":
        raise TokenError("not an access token")

    def _uuid_or_none(key: str) -> uuid.UUID | None:
        raw = payload.get(key)
        if not raw:
            return None
        try:
            return uuid.UUID(str(raw))
        except ValueError as exc:
            raise TokenError(f"claim {key!r} is not a valid uuid") from exc

    realm = payload.get("realm")
    role = payload.get("role")
    if realm not in ("app", "police") or not isinstance(role, str) or not role:
        raise TokenError("missing or invalid realm/role claims")

    return TokenClaims(
        subject=str(payload["sub"]),
        realm=realm,
        role=role,
        tenant_id=_uuid_or_none("tenant_id"),
        restaurant_id=_uuid_or_none("restaurant_id"),
    )
