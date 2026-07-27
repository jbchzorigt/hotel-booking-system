"""
Platform-admin endpoints: revenue dashboard, demand analytics, Excel export.

All endpoints are gated to PLATFORM_ADMIN; ``get_scoped_session`` injects
``platform_session()``, whose RLS identity is the only one allowed to read
``platform_accounts`` / ``platform_ledger_entries`` — and which sees every
tenant, because reconciliation is legitimately cross-tenant.

Reporting reads the LEDGER, not the wallet: ``PlatformAccount.balance`` is
a cache for hot-path credit/debit; every aggregate below is derived from
the append-only ``platform_ledger_entries`` so the numbers are auditable.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel
from sqlalchemy import bindparam, case, func, select, text

from app.dependencies.auth import AuthContext, ScopedSession, require_roles
from app.models.domain import (
    Booking,
    BookingStatus,
    EscrowStatus,
    LedgerDirection,
    MinibarConsumption,
    PlatformAccount,
    PlatformLedgerEntry,
    Room,
    RoomState,
    Tenant,
    UserRole,
)
from app.services.payment_escrow_service import (
    EscrowService,
    InvalidEscrowStateError,
    PayableNotFoundError,
    PaymentError,
)

router = APIRouter(prefix="/admin", tags=["platform-admin"])

AdminCtx = Annotated[AuthContext, Depends(require_roles(UserRole.PLATFORM_ADMIN))]

_XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)


# ===========================================================================
# Schemas
# ===========================================================================
class RevenueDashboard(BaseModel):
    currency: str
    #: Live wallet balance (cache; reconciles against the ledger below).
    wallet_balance: Decimal
    commission_rate: Decimal
    #: Lifetime commission credited, from the ledger (auditable truth).
    total_commission_collected: Decimal
    #: Lifetime debits (payouts, refunds).
    total_debited: Decimal
    #: Credit breakdown by source (BOOKING_COMMISSION, MINIBAR_COMMISSION, …).
    by_source: dict[str, Decimal]
    ledger_entries: int


class TopRoom(BaseModel):
    room_id: uuid.UUID
    room_number: str
    hotel_name: str
    #: Bookings that held or moved money (CANCELLED/NO_SHOW excluded).
    demand: int
    gross_revenue: Decimal


class PoliceAlertOut(BaseModel):
    """
    REDACTED police-match view for the platform operator dashboard.

    Metadata only — enough to see that screening is working and where a
    hit occurred, deliberately WITHOUT the raw registry number (never
    stored) or the registry_hash. The authoritative dispatch surface
    remains the police realm's own ``GET /api/v1/police/matches``.
    """

    match_id: uuid.UUID
    matched_at: datetime
    status: str
    wanted_full_name: str
    case_reference: str | None
    tenant_id: uuid.UUID
    hotel_name: str
    room_number: str
    booking_code: str
    guest_full_name: str


# ===========================================================================
# GET /dashboard/revenue
# ===========================================================================
@router.get("/dashboard/revenue", response_model=RevenueDashboard)
async def revenue_dashboard(
    ctx: AdminCtx, session: ScopedSession
) -> RevenueDashboard:
    """Platform commission position: wallet + ledger-derived aggregates."""
    account = (
        await session.execute(select(PlatformAccount).limit(1))
    ).scalar_one()

    rows = (
        await session.execute(
            select(
                PlatformLedgerEntry.direction,
                PlatformLedgerEntry.source_type,
                func.coalesce(func.sum(PlatformLedgerEntry.amount), 0),
                func.count(),
            ).group_by(
                PlatformLedgerEntry.direction, PlatformLedgerEntry.source_type
            )
        )
    ).all()

    by_source: dict[str, Decimal] = {}
    total_credit = total_debit = Decimal("0.00")
    entries = 0
    for direction, source_type, amount, count in rows:
        entries += count
        if direction == LedgerDirection.CREDIT:
            total_credit += amount
            by_source[source_type.value] = (
                by_source.get(source_type.value, Decimal("0.00")) + amount
            )
        else:
            total_debit += amount

    return RevenueDashboard(
        currency=account.currency,
        wallet_balance=account.balance,
        commission_rate=account.commission_rate,
        total_commission_collected=total_credit,
        total_debited=total_debit,
        by_source=by_source,
        ledger_entries=entries,
    )


# ===========================================================================
# GET /dashboard/top-rooms
# ===========================================================================
@router.get("/dashboard/top-rooms", response_model=list[TopRoom])
async def top_rooms(ctx: AdminCtx, session: ScopedSession) -> list[TopRoom]:
    """Top 5 most-demanded rooms platform-wide (live bookings only)."""
    demand = func.count(Booking.id).label("demand")
    rows = (
        await session.execute(
            select(
                Room.id,
                Room.room_number,
                Tenant.name,
                demand,
                func.coalesce(func.sum(Booking.total_amount), 0).label("gross"),
            )
            .join(Booking, Booking.room_id == Room.id)
            .join(Tenant, Room.tenant_id == Tenant.id)
            .where(
                Booking.status.notin_(
                    [BookingStatus.CANCELLED, BookingStatus.NO_SHOW]
                )
            )
            .group_by(Room.id, Room.room_number, Tenant.name)
            .order_by(demand.desc(), func.sum(Booking.total_amount).desc())
            .limit(5)
        )
    ).all()
    return [
        TopRoom(
            room_id=room_id,
            room_number=room_number,
            hotel_name=hotel_name,
            demand=demand_count,
            gross_revenue=gross,
        )
        for room_id, room_number, hotel_name, demand_count, gross in rows
    ]


# ===========================================================================
# GET /export/revenue — styled .xlsx, streamed as a download
# ===========================================================================
_HEADER_FONT = Font(bold=True, color="FFFFFF")
_HEADER_FILL = PatternFill("solid", fgColor="1F4E79")
_MONEY_FORMAT = "#,##0.00"


def _style_header(worksheet, columns: list[str], widths: list[int]) -> None:
    for index, (title, width) in enumerate(zip(columns, widths), start=1):
        cell = worksheet.cell(row=1, column=index, value=title)
        cell.font = _HEADER_FONT
        cell.fill = _HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
        worksheet.column_dimensions[get_column_letter(index)].width = width
    worksheet.freeze_panes = "A2"


@router.get("/export/revenue")
async def export_revenue(ctx: AdminCtx, session: ScopedSession) -> StreamingResponse:
    """
    Excel workbook, two sheets:

    * **Monthly Revenue** — ledger credits per month per source, with a
      monthly net (credits − debits) column.
    * **Minibar Statistics** — per hotel per item: quantity consumed,
      gross revenue, settled vs outstanding.
    """
    month = func.to_char(
        func.date_trunc("month", PlatformLedgerEntry.created_at), "YYYY-MM"
    ).label("month")
    signed = func.sum(
        case(
            (
                PlatformLedgerEntry.direction == LedgerDirection.CREDIT,
                PlatformLedgerEntry.amount,
            ),
            else_=-PlatformLedgerEntry.amount,
        )
    )
    revenue_rows = (
        await session.execute(
            select(
                month,
                PlatformLedgerEntry.source_type,
                func.sum(PlatformLedgerEntry.amount),
                func.count(),
                signed,
            )
            .group_by(month, PlatformLedgerEntry.source_type)
            .order_by(month, PlatformLedgerEntry.source_type)
        )
    ).all()

    minibar_rows = (
        await session.execute(
            select(
                Tenant.name,
                MinibarConsumption.item_name,
                func.sum(MinibarConsumption.quantity),
                func.sum(
                    MinibarConsumption.unit_price * MinibarConsumption.quantity
                ),
                func.sum(
                    case((MinibarConsumption.is_settled.is_(True), 1), else_=0)
                ),
            )
            .join(Tenant, MinibarConsumption.tenant_id == Tenant.id)
            .group_by(Tenant.name, MinibarConsumption.item_name)
            .order_by(Tenant.name, MinibarConsumption.item_name)
        )
    ).all()

    workbook = Workbook()

    # -- Sheet 1: Monthly Revenue ----------------------------------------- #
    sheet = workbook.active
    sheet.title = "Monthly Revenue"
    _style_header(
        sheet,
        ["Month", "Source", "Amount (MNT)", "Entries", "Net Movement (MNT)"],
        [12, 28, 18, 10, 20],
    )
    row_index = 2
    grand_total = Decimal("0.00")
    for month_label, source_type, amount, count, net in revenue_rows:
        sheet.cell(row=row_index, column=1, value=month_label)
        sheet.cell(row=row_index, column=2, value=source_type.value)
        sheet.cell(row=row_index, column=3, value=float(amount)).number_format = (
            _MONEY_FORMAT
        )
        sheet.cell(row=row_index, column=4, value=count)
        sheet.cell(row=row_index, column=5, value=float(net)).number_format = (
            _MONEY_FORMAT
        )
        grand_total += net
        row_index += 1
    total_label = sheet.cell(row=row_index, column=2, value="TOTAL NET")
    total_label.font = Font(bold=True)
    total_cell = sheet.cell(row=row_index, column=5, value=float(grand_total))
    total_cell.font = Font(bold=True)
    total_cell.number_format = _MONEY_FORMAT

    # -- Sheet 2: Minibar Statistics --------------------------------------- #
    sheet = workbook.create_sheet("Minibar Statistics")
    _style_header(
        sheet,
        ["Hotel", "Item", "Qty Consumed", "Revenue (MNT)", "Settled Lines"],
        [24, 28, 14, 16, 14],
    )
    for row_index, (hotel, item, qty, revenue, settled) in enumerate(
        minibar_rows, start=2
    ):
        sheet.cell(row=row_index, column=1, value=hotel)
        sheet.cell(row=row_index, column=2, value=item)
        sheet.cell(row=row_index, column=3, value=int(qty))
        sheet.cell(row=row_index, column=4, value=float(revenue)).number_format = (
            _MONEY_FORMAT
        )
        sheet.cell(row=row_index, column=5, value=int(settled))

    buffer = io.BytesIO()
    workbook.save(buffer)
    buffer.seek(0)

    filename = (
        f"platform_revenue_{datetime.now(timezone.utc):%Y%m%d_%H%M}.xlsx"
    )
    return StreamingResponse(
        buffer,
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ===========================================================================
# GET /police-alerts — redacted, admin-visible projection of police matches
# ===========================================================================
_POLICE_ALERTS_SQL = text(
    "SELECT match_id, matched_at, status, wanted_full_name, case_reference, "
    "tenant_id, hotel_name, room_number, booking_code, guest_full_name "
    "FROM admin_police_alerts(:limit)"
).bindparams(bindparam("limit"))


@router.get("/police-alerts", response_model=list[PoliceAlertOut])
async def list_police_alerts(
    ctx: AdminCtx,
    session: ScopedSession,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[PoliceAlertOut]:
    """
    Newest-first police matches, redacted for the platform operator.

    Reads through the ``admin_police_alerts`` SECURITY DEFINER function:
    the platform admin's own DB role (``app_runtime``) has NO grants on the
    police tables, so this controlled projection — metadata only, no raw
    registry number — is the sole way platform-realm sessions can observe
    that screening is producing hits. The function's internal
    ``app_is_platform_admin()`` guard means a non-admin app session calling
    it would get nothing.
    """
    rows = (await session.execute(_POLICE_ALERTS_SQL, {"limit": limit})).all()
    return [PoliceAlertOut(**row._mapping) for row in rows]


# ===========================================================================
# Zero-trust arrivals: override queue, manual approval, no-show settlement
# ===========================================================================
_escrow = EscrowService()


class OverrideBookingOut(BaseModel):
    booking_id: uuid.UUID
    booking_code: str
    hotel_name: str
    room_number: str
    guest_full_name: str
    check_in_date: str
    check_out_date: str
    total_amount: Decimal
    override_requested: bool
    pin_verified: bool


class OverrideApprovedOut(BaseModel):
    booking_id: uuid.UUID
    status: BookingStatus
    pin_verified: bool
    escrow_status: EscrowStatus
    commission_amount: Decimal
    hotel_amount: Decimal


class NoShowOut(BaseModel):
    booking_id: uuid.UUID
    status: BookingStatus
    escrow_status: EscrowStatus
    penalty_amount: Decimal
    commission_amount: Decimal
    hotel_amount: Decimal
    #: Mock refund of the unused nights back to the guest.
    refunded_amount: Decimal


@router.get("/bookings/overrides", response_model=list[OverrideBookingOut])
async def list_override_requests(
    ctx: AdminCtx, session: ScopedSession
) -> list[OverrideBookingOut]:
    """Manual check-in queue: guests who lost their PIN and are waiting for
    a platform-admin override (requested, not yet verified)."""
    rows = (
        await session.execute(
            select(Booking, Room.room_number, Tenant.name)
            .join(Room, Booking.room_id == Room.id)
            .join(Tenant, Booking.tenant_id == Tenant.id)
            .where(
                Booking.override_requested.is_(True),
                Booking.pin_verified.is_(False),
                Booking.status == BookingStatus.CONFIRMED,
            )
            .order_by(Booking.check_in_date, Booking.created_at)
        )
    ).all()
    return [
        OverrideBookingOut(
            booking_id=b.id,
            booking_code=b.code,
            hotel_name=hotel_name,
            room_number=room_number,
            guest_full_name=b.guest_full_name,
            check_in_date=b.check_in_date.isoformat(),
            check_out_date=b.check_out_date.isoformat(),
            total_amount=b.total_amount,
            override_requested=b.override_requested,
            pin_verified=b.pin_verified,
        )
        for b, room_number, hotel_name in rows
    ]


@router.post(
    "/bookings/{booking_id}/approve-override", response_model=OverrideApprovedOut
)
async def approve_override(
    booking_id: uuid.UUID, ctx: AdminCtx, session: ScopedSession
) -> OverrideApprovedOut:
    """
    Approve a manual check-in for a guest who lost their PIN: marks the
    booking verified + CHECKED_IN, occupies the room, and releases the
    escrow — the admin's judgement substitutes for the PIN.

    Same no-self-deadlock ordering as reception: plain read -> escrow
    release in its own platform txn (tolerant of already-RELEASED for
    retries) -> mutations on the request session.
    """
    row = (
        await session.execute(
            select(Booking, Room)
            .join(Room, Booking.room_id == Room.id)
            .where(Booking.id == booking_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    booking, room = row

    if not booking.override_requested:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "no override was requested for this booking"
        )
    if booking.status != BookingStatus.CONFIRMED:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"booking is {booking.status.value}; only CONFIRMED bookings "
            "can be override-approved",
        )
    if room.state != RoomState.VACANT_CLEAN:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"room {room.room_number} is {room.state.value}; "
            "housekeeping must clear it first",
        )

    try:
        settlement = await _escrow.release_booking_escrow(booking.id)
        commission, hotel_amount = (
            settlement.commission_amount,
            settlement.merchant_amount,
        )
    except InvalidEscrowStateError:
        if booking.escrow_status != EscrowStatus.RELEASED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"escrow is {booking.escrow_status.value}; cannot release",
            )
        commission = booking.commission_amount
        hotel_amount = booking.total_amount - commission
    except PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    booking.pin_verified = True
    booking.status = BookingStatus.CHECKED_IN
    room.state = RoomState.OCCUPIED

    return OverrideApprovedOut(
        booking_id=booking.id,
        status=BookingStatus.CHECKED_IN,
        pin_verified=True,
        escrow_status=EscrowStatus.RELEASED,
        commission_amount=commission,
        hotel_amount=hotel_amount,
    )


@router.post(
    "/bookings/{booking_id}/process-no-show", response_model=NoShowOut
)
async def process_no_show(
    booking_id: uuid.UUID, ctx: AdminCtx, session: ScopedSession
) -> NoShowOut:
    """
    Settle a guest who never arrived: a ONE-night penalty is released to
    the hotel (standard commission split at the booking's snapshotted
    rate), the remainder is refunded to the guest (mock), the booking goes
    NO_SHOW — which also frees the GiST date range for resale.

    The whole settlement runs inside the escrow service's own locked
    platform transaction; this endpoint only translates errors.
    """
    try:
        result = await _escrow.settle_no_show(booking_id)
    except PayableNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    except InvalidEscrowStateError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except PaymentError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))

    return NoShowOut(
        booking_id=result.booking_id,
        status=BookingStatus.NO_SHOW,
        escrow_status=EscrowStatus.REFUNDED,
        penalty_amount=result.penalty_amount,
        commission_amount=result.commission_amount,
        hotel_amount=result.hotel_amount,
        refunded_amount=result.refunded_amount,
    )
