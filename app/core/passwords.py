"""
Password hashing (passlib / bcrypt).

*   bcrypt with passlib's ``deprecated="auto"``: if we ever migrate to
    argon2, old hashes verify fine and ``needs_update()`` flags them for
    transparent re-hash on next login.
*   bcrypt silently truncates at 72 bytes — the API layer caps password
    length well below that, and we assert it here as defense in depth.
*   ``DUMMY_HASH`` lets the login endpoint burn the same bcrypt cost for
    unknown emails as for real ones, so response timing does not disclose
    whether an account exists.
"""

from __future__ import annotations

from passlib.context import CryptContext

_MAX_PASSWORD_BYTES = 72  # bcrypt's hard input limit

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """Hash a plaintext password for storage."""
    if len(plain.encode("utf-8")) > _MAX_PASSWORD_BYTES:
        raise ValueError("password exceeds the 72-byte bcrypt limit")
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-cost verification; malformed hashes count as failure."""
    try:
        return _pwd_context.verify(plain, hashed)
    except (ValueError, TypeError):
        return False


#: Verified against when the email doesn't exist — see module docstring.
DUMMY_HASH: str = _pwd_context.hash("timing-equalizer-dummy-password")
