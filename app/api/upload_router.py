"""
Authenticated image uploads for content managers (menu photos etc.).

Security posture — every rule here exists because file upload is a classic
attack surface:

*   **Auth required.** Content-managing roles only (restaurant managers,
    hotel managers/admins, platform admins) — never anonymous: an open
    upload endpoint is free hosting for phishing/malware.
*   **The client's filename is never used.** Names are server-generated
    (``uuid4`` + validated extension), which kills path traversal
    (``../../etc/cron.d/x``) and overwrite attacks outright.
*   **Content is validated, not just headers.** The declared content type
    AND the file's magic bytes must both match an allow-listed image
    format — renaming ``shell.php`` to ``menu.jpg`` fails the sniff.
*   **Hard size cap**, enforced while streaming (an attacker cannot OOM
    the worker by lying about Content-Length).
*   Files land in ``static/uploads/`` (created on import, gitignored) and
    are served by Starlette's ``StaticFiles`` mounted in ``main.py`` —
    which serves regular files only and never executes anything.

Ops note: local disk is fine for single-node deployments; move to object
storage (S3/GCS) behind the same response contract when scaling out.
"""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.dependencies.auth import AuthContext, require_roles
from app.models.domain import UserRole

router = APIRouter(prefix="/upload", tags=["uploads"])

UploaderCtx = Annotated[
    AuthContext,
    Depends(
        require_roles(
            UserRole.RESTAURANT_OWNER,
            UserRole.MANAGER,
            UserRole.HOTEL_ADMIN,
            UserRole.PLATFORM_ADMIN,
        )
    ),
]

#: Project-root-anchored so the path is cwd-independent.
STATIC_ROOT = Path(__file__).resolve().parents[2] / "static"
UPLOADS_DIR = STATIC_ROOT / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

_MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MiB
_CHUNK = 64 * 1024

#: content-type -> (extension, magic-byte prefixes that prove the format)
_ALLOWED_IMAGE_TYPES: dict[str, tuple[str, tuple[bytes, ...]]] = {
    "image/jpeg": (".jpg", (b"\xff\xd8\xff",)),
    "image/png": (".png", (b"\x89PNG\r\n\x1a\n",)),
    "image/webp": (".webp", (b"RIFF",)),  # + 'WEBP' at offset 8, checked below
    "image/gif": (".gif", (b"GIF87a", b"GIF89a")),
}


class UploadResult(BaseModel):
    url: str
    filename: str
    content_type: str
    size_bytes: int


def _sniff_ok(content_type: str, head: bytes) -> bool:
    """True when the leading bytes genuinely match the declared type."""
    _, prefixes = _ALLOWED_IMAGE_TYPES[content_type]
    if not any(head.startswith(p) for p in prefixes):
        return False
    if content_type == "image/webp":
        return len(head) >= 12 and head[8:12] == b"WEBP"
    return True


@router.post("", response_model=UploadResult, status_code=status.HTTP_201_CREATED)
async def upload_image(file: UploadFile, ctx: UploaderCtx) -> UploadResult:
    """
    Store an image and return its public path
    (``{"url": "/static/uploads/<server-generated-name>"}``) for use as a
    menu item's ``image_url``.
    """
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"unsupported type {content_type!r}; allowed: "
            + ", ".join(sorted(_ALLOWED_IMAGE_TYPES)),
        )
    extension, _ = _ALLOWED_IMAGE_TYPES[content_type]

    # Server-generated name — the client's filename is untrusted input and
    # is deliberately discarded.
    filename = f"{secrets.token_hex(16)}{extension}"
    destination = UPLOADS_DIR / filename

    size = 0
    head = b""
    try:
        with destination.open("wb") as out:
            while chunk := await file.read(_CHUNK):
                if not head:
                    head = chunk[:16]
                    if not _sniff_ok(content_type, head):
                        raise HTTPException(
                            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            "file content does not match the declared "
                            "image type",
                        )
                size += len(chunk)
                if size > _MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        f"file exceeds {_MAX_UPLOAD_BYTES // (1024 * 1024)} MiB",
                    )
                out.write(chunk)
        if size == 0:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "empty file"
            )
    except HTTPException:
        destination.unlink(missing_ok=True)  # never keep rejected content
        raise
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    return UploadResult(
        url=f"/static/uploads/{filename}",
        filename=filename,
        content_type=content_type,
        size_bytes=size,
    )
