"""
JWT creation and validation (PyJWT, HS256) — with HARD realm separation.

Two realms, two independent crypto contexts
===========================================
The app realm (hotels, restaurants, platform staff, B2C guests) and the
police realm are separate security domains that happen to share a process.
They therefore get separate signing keys, separate issuers and separate
audiences:

    realm     key                          issuer                 audience
    -------   --------------------------   --------------------   ----------------
    app       JWT_SECRET_KEY               JWT_APP_ISSUER         JWT_APP_AUDIENCE
    police    POLICE_JWT_SECRET_KEY        JWT_POLICE_ISSUER      JWT_POLICE_AUDIENCE

**Validation always starts from the realm the endpoint expects**, never from
the token. Reading an unverified ``realm`` claim and then picking a key with
it would hand the attacker the key-selection decision; instead the caller
says "this endpoint is police-only" and we verify against the police key,
issuer and audience or fail. Consequently a token minted for one realm can
never validate in the other: wrong key (signature failure), wrong issuer and
wrong audience — three independent failures.

Claim model
===========
    sub            user id (uuid) — or police officer id in the police realm
    iss / aud      realm-specific, verified (see table above)
    realm          "app" | "police" — defence in depth only; the signature,
                   issuer and audience already pinned the realm before this
                   claim is read, and a mismatch is treated as forgery
    role           UserRole value, or "POLICE" for the police realm
    tenant_id      uuid string, only for hotel-staff roles
    restaurant_id  uuid string, only for RESTAURANT_OWNER
    type           "access" (refresh tokens are Phase 4)
    iat / exp      standard timestamps — both REQUIRED

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

#: Realm identifiers. Not free-form strings anywhere else in the codebase.
APP_REALM = "app"
POLICE_REALM = "police"

#: Claims every token must carry for us to even look at it.
_REQUIRED_CLAIMS = ["exp", "iat", "sub", "iss", "aud"]


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


@dataclass(frozen=True, slots=True)
class _RealmCrypto:
    """The signing material and identity claims for exactly one realm."""

    realm: str
    key: str
    issuer: str
    audience: str


def _app_crypto() -> _RealmCrypto:
    return _RealmCrypto(
        realm=APP_REALM,
        key=settings.JWT_SECRET_KEY.get_secret_value(),
        issuer=settings.JWT_APP_ISSUER,
        audience=settings.JWT_APP_AUDIENCE,
    )


def _police_crypto() -> _RealmCrypto:
    return _RealmCrypto(
        realm=POLICE_REALM,
        key=settings.POLICE_JWT_SECRET_KEY.get_secret_value(),
        issuer=settings.JWT_POLICE_ISSUER,
        audience=settings.JWT_POLICE_AUDIENCE,
    )


# ---------------------------------------------------------------------------
# Minting
# ---------------------------------------------------------------------------
# Minting is a TRUSTED operation: the caller is our own login endpoint and it
# knows which realm it is issuing for. Selecting the key by realm is therefore
# safe here — unlike on the decode path, where the realm is attacker-supplied.
def _encode(
    crypto: _RealmCrypto,
    *,
    subject: str,
    role: str,
    tenant_id: uuid.UUID | None,
    restaurant_id: uuid.UUID | None,
    expires_minutes: int | None,
) -> str:
    now = datetime.now(timezone.utc)
    lifetime = timedelta(
        minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload: dict[str, object] = {
        "iss": crypto.issuer,
        "aud": crypto.audience,
        "sub": subject,
        "type": "access",
        "realm": crypto.realm,
        "role": role,
        "tenant_id": str(tenant_id) if tenant_id else None,
        "restaurant_id": str(restaurant_id) if restaurant_id else None,
        "iat": now,
        "exp": now + lifetime,
    }
    return jwt.encode(payload, crypto.key, algorithm=settings.JWT_ALGORITHM)


def create_app_access_token(
    *,
    subject: str,
    role: str,
    tenant_id: uuid.UUID | None = None,
    restaurant_id: uuid.UUID | None = None,
    expires_minutes: int | None = None,
) -> str:
    """Mint an APP-realm access token (hotel staff, platform admin, guest)."""
    return _encode(
        _app_crypto(),
        subject=subject,
        role=role,
        tenant_id=tenant_id,
        restaurant_id=restaurant_id,
        expires_minutes=expires_minutes,
    )


def create_police_access_token(
    *,
    subject: str,
    role: str,
    expires_minutes: int | None = None,
) -> str:
    """Mint a POLICE-realm access token. Police principals never carry
    tenant/restaurant scope — the realm is cross-tenant by design."""
    return _encode(
        _police_crypto(),
        subject=subject,
        role=role,
        tenant_id=None,
        restaurant_id=None,
        expires_minutes=expires_minutes,
    )


def create_access_token(
    *,
    subject: str,
    role: str,
    realm: str = APP_REALM,
    tenant_id: uuid.UUID | None = None,
    restaurant_id: uuid.UUID | None = None,
    expires_minutes: int | None = None,
) -> str:
    """
    Realm-dispatching mint helper.

    Safe because minting is trusted: our own code chooses the realm. The
    decode path deliberately has NO such helper — see ``decode_app_access_
    token`` / ``decode_police_access_token``.
    """
    if realm == POLICE_REALM:
        if tenant_id or restaurant_id:
            raise ValueError("police tokens must not carry tenant/restaurant ids")
        return create_police_access_token(
            subject=subject, role=role, expires_minutes=expires_minutes
        )
    if realm != APP_REALM:
        raise ValueError(f"unknown realm {realm!r}")
    return create_app_access_token(
        subject=subject,
        role=role,
        tenant_id=tenant_id,
        restaurant_id=restaurant_id,
        expires_minutes=expires_minutes,
    )


# ---------------------------------------------------------------------------
# Validation — realm is an INPUT, never read from the token first
# ---------------------------------------------------------------------------
def _decode(crypto: _RealmCrypto, token: str) -> TokenClaims:
    try:
        payload = jwt.decode(
            token,
            crypto.key,
            algorithms=[settings.JWT_ALGORITHM],  # pinned: no alg-confusion
            issuer=crypto.issuer,
            audience=crypto.audience,
            options={"require": _REQUIRED_CLAIMS},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(f"invalid token: {exc}") from exc

    if payload.get("type") != "access":
        raise TokenError("not an access token")

    # The signature, issuer and audience already pinned the realm. This check
    # only catches our own minting bugs — a token whose body disagrees with
    # the key it was signed under is treated as forged.
    if payload.get("realm") != crypto.realm:
        raise TokenError("realm claim does not match the validating realm")

    role = payload.get("role")
    if not isinstance(role, str) or not role:
        raise TokenError("missing or invalid role claim")

    def _uuid_or_none(key: str) -> uuid.UUID | None:
        raw = payload.get(key)
        if not raw:
            return None
        try:
            return uuid.UUID(str(raw))
        except ValueError as exc:
            raise TokenError(f"claim {key!r} is not a valid uuid") from exc

    return TokenClaims(
        subject=str(payload["sub"]),
        realm=crypto.realm,
        role=role,
        tenant_id=_uuid_or_none("tenant_id"),
        restaurant_id=_uuid_or_none("restaurant_id"),
    )


def decode_app_access_token(token: str) -> TokenClaims:
    """
    Validate a token as an APP-realm credential.

    Verifies against the app key, app issuer and app audience ONLY. A police
    token fails here on all three counts.

    Raises:
        TokenError: on any validation failure — callers translate to 401.
    """
    return _decode(_app_crypto(), token)


def decode_police_access_token(token: str) -> TokenClaims:
    """
    Validate a token as a POLICE-realm credential.

    Verifies against the police key, police issuer and police audience ONLY.
    An app token — including a PLATFORM_ADMIN one — fails here.

    Raises:
        TokenError: on any validation failure — callers translate to 401.
    """
    return _decode(_police_crypto(), token)
