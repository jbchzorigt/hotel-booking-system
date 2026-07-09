"""
Government integrations: State KHUR citizen registry + e-Mongolia OAuth.

Architecture — Ports & Adapters
===============================
The rest of the codebase depends only on the ``KhurApiPort`` and
``EMongoliaOAuthPort`` protocols. Two adapters exist per port:

*   ``Mock*``  — deterministic, latency-simulating fakes for local dev,
    CI and demos. Selected when ``settings.GOV_USE_MOCKS`` is True
    (the config fail-fast guard forbids that in production).
*   ``Http*``  — real HTTPS adapters (httpx), production wiring.

Determinism matters in the mocks: the same registry number always yields
the same citizen, so booking → check-in → police-screening flows are
reproducible in tests without fixtures.

Security notes
==============
*   Registry numbers (РД) are PII. They are validated and normalised here,
    passed to the state API, hashed for internal storage (see
    ``police_service.compute_registry_hash``) — and never logged.
*   The OAuth ``state`` parameter is an HMAC-signed, expiring token
    (stateless CSRF protection) — no server-side session storage needed.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlencode

from app.core.config import settings

# ===========================================================================
# Errors
# ===========================================================================
class GovServiceError(Exception):
    """Base class for all government-integration failures."""


class InvalidRegistryNumberError(GovServiceError):
    """The supplied registry number is not a syntactically valid РД."""


class CitizenNotFoundError(GovServiceError):
    """KHUR has no record for this registry number."""


class GovUpstreamError(GovServiceError):
    """The state API is unreachable or returned an unexpected response."""


class OAuthStateError(GovServiceError):
    """OAuth ``state`` failed validation (tampered, expired or malformed)."""


class OAuthExchangeError(GovServiceError):
    """Authorization-code exchange or profile fetch failed."""


# ===========================================================================
# Registry-number handling (Mongolian РД: 2 Cyrillic letters + 8 digits)
# ===========================================================================
REGISTRY_NUMBER_RE = re.compile(r"^[А-ЯЁӨҮ]{2}\d{8}$")


def normalize_registry_number(raw: str) -> str:
    """
    Canonical form: uppercase, no whitespace/hyphens.

    Raises:
        InvalidRegistryNumberError: if the result is not a valid РД shape.
    """
    candidate = re.sub(r"[\s\-]+", "", raw or "").upper()
    if not REGISTRY_NUMBER_RE.match(candidate):
        raise InvalidRegistryNumberError(
            "registry number must be 2 Cyrillic letters followed by 8 digits"
        )
    return candidate


# ===========================================================================
# KHUR (ХУР) citizen registry
# ===========================================================================
@dataclass(frozen=True, slots=True)
class KhurCitizen:
    """Citizen record as returned by the state KHUR system."""

    registry_number: str
    full_name: str
    address: str


class KhurApiPort(Protocol):
    """Contract every KHUR adapter must satisfy."""

    async def fetch_citizen(self, registry_number: str) -> KhurCitizen:
        """
        Resolve a registry number to the citizen's identity.

        Raises:
            InvalidRegistryNumberError: malformed input.
            CitizenNotFoundError: no such citizen.
            GovUpstreamError: transport/protocol failure.
        """
        ...


class MockKhurApi:
    """
    Deterministic KHUR fake.

    * Same registry number -> same citizen, across processes and runs.
    * Registry numbers whose digits end in ``99`` raise
      ``CitizenNotFoundError`` — a stable "unhappy path" for tests.
    * ~50 ms simulated latency so accidental sync-over-async misuse of the
      adapter shows up in local profiling, not in production.
    """

    _SURNAMES = ("Бат", "Болд", "Дорж", "Ганбаатар", "Энхбаяр", "Цэрэн")
    _NAMES = ("Тэмүүлэн", "Ануджин", "Мөнхжин", "Билгүүн", "Сарнай", "Хулан")
    _DISTRICTS = (
        "Сүхбаатар дүүрэг, 1-р хороо",
        "Чингэлтэй дүүрэг, 4-р хороо",
        "Баянзүрх дүүрэг, 26-р хороо",
        "Хан-Уул дүүрэг, 11-р хороо",
        "Баянгол дүүрэг, 6-р хороо",
    )

    async def fetch_citizen(self, registry_number: str) -> KhurCitizen:
        rn = normalize_registry_number(registry_number)
        await asyncio.sleep(0.05)  # simulated network round-trip

        if rn.endswith("99"):
            raise CitizenNotFoundError(f"no KHUR record (mock rule: *99)")

        # Deterministic pseudo-identity derived from the registry number.
        digest = hashlib.sha256(rn.encode("utf-8")).digest()
        surname = self._SURNAMES[digest[0] % len(self._SURNAMES)]
        name = self._NAMES[digest[1] % len(self._NAMES)]
        district = self._DISTRICTS[digest[2] % len(self._DISTRICTS)]
        building = digest[3] % 90 + 1
        apartment = digest[4] % 120 + 1
        return KhurCitizen(
            registry_number=rn,
            full_name=f"{surname} {name}",
            address=f"Улаанбаатар, {district}, {building}-р байр, {apartment} тоот",
        )


class HttpKhurApi:
    """
    Production KHUR adapter.

    Endpoint contract (per the state integration spec):
        POST {KHUR_API_BASE_URL}/citizen/lookup
        headers: X-Api-Key
        body:    {"registry_number": "..."}
        200 ->   {"full_name": "...", "address": "..."}
        404 ->   citizen not found
    """

    _TIMEOUT_SECONDS = 10.0

    async def fetch_citizen(self, registry_number: str) -> KhurCitizen:
        import httpx  # local import: dev/test environments run mock-only

        rn = normalize_registry_number(registry_number)
        try:
            async with httpx.AsyncClient(timeout=self._TIMEOUT_SECONDS) as client:
                response = await client.post(
                    f"{settings.KHUR_API_BASE_URL}/citizen/lookup",
                    json={"registry_number": rn},
                    headers={
                        "X-Api-Key": settings.KHUR_API_KEY.get_secret_value()
                    },
                )
        except httpx.HTTPError as exc:
            raise GovUpstreamError(f"KHUR unreachable: {exc!r}") from exc

        if response.status_code == 404:
            raise CitizenNotFoundError("no KHUR record for registry number")
        if response.status_code != 200:
            raise GovUpstreamError(f"KHUR returned HTTP {response.status_code}")

        payload: dict[str, Any] = response.json()
        try:
            return KhurCitizen(
                registry_number=rn,
                full_name=payload["full_name"],
                address=payload["address"],
            )
        except KeyError as exc:
            raise GovUpstreamError(f"KHUR response missing field {exc}") from exc


# ===========================================================================
# e-Mongolia OAuth 2.0 (authorization-code flow)
# ===========================================================================
@dataclass(frozen=True, slots=True)
class EMongoliaToken:
    access_token: str
    token_type: str
    expires_in: int


@dataclass(frozen=True, slots=True)
class EMongoliaProfile:
    """Verified citizen identity as asserted by e-Mongolia SSO."""

    subject: str            # stable e-Mongolia user id ("sub" claim)
    registry_number: str    # РД, already state-verified
    full_name: str
    email: str | None


class EMongoliaOAuthPort(Protocol):
    def build_authorization_url(self, state: str) -> str: ...

    async def exchange_code(self, code: str) -> EMongoliaToken:
        """Raises OAuthExchangeError on failure."""
        ...

    async def fetch_profile(self, token: EMongoliaToken) -> EMongoliaProfile:
        """Raises OAuthExchangeError on failure."""
        ...


# --------------------------------------------------------------------------
# Stateless CSRF protection for the OAuth flow.
#
# state = "<nonce>.<issued_at>.<hmac(nonce.issued_at)>"
# Signed with SECRET_KEY: nothing to store server-side, horizontally
# scalable, expires after EMONGOLIA_STATE_TTL_SECONDS.
# --------------------------------------------------------------------------
def _sign(payload: str) -> str:
    key = settings.SECRET_KEY.get_secret_value().encode("utf-8")
    return hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def generate_oauth_state() -> str:
    payload = f"{secrets.token_urlsafe(16)}.{int(time.time())}"
    return f"{payload}.{_sign(payload)}"


def validate_oauth_state(state: str) -> None:
    """Raises OAuthStateError unless ``state`` is authentic and fresh."""
    try:
        nonce, issued_at_raw, signature = state.split(".")
        issued_at = int(issued_at_raw)
    except (ValueError, AttributeError) as exc:
        raise OAuthStateError("malformed state parameter") from exc

    expected = _sign(f"{nonce}.{issued_at_raw}")
    if not hmac.compare_digest(signature, expected):
        raise OAuthStateError("state signature mismatch")
    if time.time() - issued_at > settings.EMONGOLIA_STATE_TTL_SECONDS:
        raise OAuthStateError("state expired — restart the login flow")


class MockEMongoliaOAuth:
    """
    Deterministic e-Mongolia fake.

    Accepts any code beginning with ``mock-code-``; the remainder seeds the
    fabricated profile, so tests can steer which "citizen" logs in:
    ``mock-code-alice`` always yields the same profile.
    """

    def build_authorization_url(self, state: str) -> str:
        query = urlencode(
            {
                "response_type": "code",
                "client_id": settings.EMONGOLIA_CLIENT_ID,
                "redirect_uri": settings.EMONGOLIA_REDIRECT_URI,
                "scope": "openid profile registry_number email",
                "state": state,
            }
        )
        return f"{settings.EMONGOLIA_AUTH_BASE_URL}/authorize?{query}"

    async def exchange_code(self, code: str) -> EMongoliaToken:
        await asyncio.sleep(0.05)
        if not code.startswith("mock-code-"):
            raise OAuthExchangeError("mock adapter only accepts 'mock-code-*'")
        seed = code.removeprefix("mock-code-")
        return EMongoliaToken(
            access_token=f"mock-token-{seed}",
            token_type="Bearer",
            expires_in=3600,
        )

    async def fetch_profile(self, token: EMongoliaToken) -> EMongoliaProfile:
        await asyncio.sleep(0.05)
        if not token.access_token.startswith("mock-token-"):
            raise OAuthExchangeError("invalid mock access token")
        seed = token.access_token.removeprefix("mock-token-")
        digest = hashlib.sha256(seed.encode("utf-8")).digest()

        # Fabricate a VALID registry number so downstream hashing/screening
        # works end-to-end in dev: 2 Cyrillic letters + 8 digits.
        letters = "АБВГДЕЖЗ"
        rn = (
            letters[digest[0] % len(letters)]
            + letters[digest[1] % len(letters)]
            + "".join(str(digest[2 + i] % 10) for i in range(8))
        )
        citizen = await MockKhurApi().fetch_citizen(rn)
        return EMongoliaProfile(
            subject=f"emongolia-{digest.hex()[:12]}",
            registry_number=citizen.registry_number,
            full_name=citizen.full_name,
            email=f"{seed}@example.mn",
        )


class HttpEMongoliaOAuth:
    """Production e-Mongolia adapter (standard authorization-code flow)."""

    _TIMEOUT_SECONDS = 10.0

    def build_authorization_url(self, state: str) -> str:
        query = urlencode(
            {
                "response_type": "code",
                "client_id": settings.EMONGOLIA_CLIENT_ID,
                "redirect_uri": settings.EMONGOLIA_REDIRECT_URI,
                "scope": "openid profile registry_number email",
                "state": state,
            }
        )
        return f"{settings.EMONGOLIA_AUTH_BASE_URL}/authorize?{query}"

    async def exchange_code(self, code: str) -> EMongoliaToken:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self._TIMEOUT_SECONDS) as client:
                response = await client.post(
                    f"{settings.EMONGOLIA_AUTH_BASE_URL}/token",
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": settings.EMONGOLIA_REDIRECT_URI,
                        "client_id": settings.EMONGOLIA_CLIENT_ID,
                        "client_secret": (
                            settings.EMONGOLIA_CLIENT_SECRET.get_secret_value()
                        ),
                    },
                )
        except httpx.HTTPError as exc:
            raise OAuthExchangeError(f"token endpoint unreachable: {exc!r}") from exc
        if response.status_code != 200:
            raise OAuthExchangeError(f"token endpoint HTTP {response.status_code}")
        body = response.json()
        return EMongoliaToken(
            access_token=body["access_token"],
            token_type=body.get("token_type", "Bearer"),
            expires_in=int(body.get("expires_in", 3600)),
        )

    async def fetch_profile(self, token: EMongoliaToken) -> EMongoliaProfile:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self._TIMEOUT_SECONDS) as client:
                response = await client.get(
                    f"{settings.EMONGOLIA_AUTH_BASE_URL}/userinfo",
                    headers={"Authorization": f"Bearer {token.access_token}"},
                )
        except httpx.HTTPError as exc:
            raise OAuthExchangeError(f"userinfo unreachable: {exc!r}") from exc
        if response.status_code != 200:
            raise OAuthExchangeError(f"userinfo HTTP {response.status_code}")
        body = response.json()
        return EMongoliaProfile(
            subject=body["sub"],
            registry_number=normalize_registry_number(body["registry_number"]),
            full_name=body["full_name"],
            email=body.get("email"),
        )


# ===========================================================================
# Adapter selection (single composition point)
# ===========================================================================
def get_khur_api() -> KhurApiPort:
    return MockKhurApi() if settings.GOV_USE_MOCKS else HttpKhurApi()


def get_emongolia_oauth() -> EMongoliaOAuthPort:
    return MockEMongoliaOAuth() if settings.GOV_USE_MOCKS else HttpEMongoliaOAuth()
