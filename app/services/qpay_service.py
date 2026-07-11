"""
QPay payment gateway — invoice creation + webhook signature verification.

Ports & adapters (mirrors gov_service): the codebase depends only on
``QPayClientPort``. ``MockQPayClient`` is deterministic for local/CI; a
real httpx adapter slots in later. ``settings.QPAY_USE_MOCKS`` selects
(the config fail-fast guard forbids mocks in production).

Payment flow this supports
==========================
    POST /public/bookings   -> create PENDING booking + QPay invoice (QR)
    guest scans/pays in QPay
    QPay -> POST /payments/qpay-webhook (signed) -> booking FUNDED (once)

Webhook authenticity: QPay signs the raw callback body with a shared
secret; we verify HMAC-SHA256 in constant time. ``sign`` is exposed so the
mock (and tests) can produce a valid signature.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Protocol

from app.core.config import settings


@dataclass(frozen=True, slots=True)
class QPayInvoice:
    """A created invoice, returned to the guest for payment."""

    invoice_id: str
    amount: Decimal
    currency: str
    #: Text encoded into the QR the guest scans in their bank/QPay app.
    qr_text: str
    #: Deep link / short URL alternative to scanning.
    payment_url: str
    expires_at: datetime

    def as_dict(self) -> dict[str, str]:
        return {
            "invoice_id": self.invoice_id,
            "amount": str(self.amount),
            "currency": self.currency,
            "qr_text": self.qr_text,
            "payment_url": self.payment_url,
            "expires_at": self.expires_at.isoformat(),
        }


class QPayClientPort(Protocol):
    async def create_invoice(
        self, *, booking_id: uuid.UUID, amount: Decimal, description: str
    ) -> QPayInvoice: ...


def _webhook_key() -> bytes:
    return settings.QPAY_WEBHOOK_SECRET.get_secret_value().encode("utf-8")


def sign_webhook(raw_body: bytes) -> str:
    """HMAC-SHA256 (hex) of the raw callback body — QPay's signature."""
    return hmac.new(_webhook_key(), raw_body, hashlib.sha256).hexdigest()


def verify_webhook(raw_body: bytes, signature: str) -> bool:
    """Constant-time signature check; malformed input counts as invalid."""
    if not signature:
        return False
    return hmac.compare_digest(signature, sign_webhook(raw_body))


class MockQPayClient:
    """Deterministic invoice generator — no network, auto-approvable."""

    async def create_invoice(
        self, *, booking_id: uuid.UUID, amount: Decimal, description: str
    ) -> QPayInvoice:
        # Deterministic per booking so a retried creation reuses the id.
        invoice_id = f"qpay-inv-{uuid.uuid5(uuid.NAMESPACE_URL, str(booking_id))}"
        expires = datetime.now(timezone.utc) + timedelta(
            minutes=settings.QPAY_INVOICE_TTL_MINUTES
        )
        return QPayInvoice(
            invoice_id=invoice_id,
            amount=amount,
            currency=settings.PLATFORM_CURRENCY,
            qr_text=f"{settings.QPAY_INVOICE_BASE_URL}/{invoice_id}",
            payment_url=f"{settings.QPAY_INVOICE_BASE_URL}/{invoice_id}",
            expires_at=expires,
        )


def get_qpay_client() -> QPayClientPort:
    if settings.QPAY_USE_MOCKS:
        return MockQPayClient()
    raise RuntimeError("real QPay adapter not configured; set QPAY_USE_MOCKS")
