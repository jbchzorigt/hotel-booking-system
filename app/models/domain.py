"""
Domain models for the Hotel Booking Marketplace & Management SaaS.

Realms
======
The schema is partitioned into four trust realms; Row-Level Security
(``scripts/enable_rls.sql``) enforces the boundaries at the database layer
so that an application-level bug can NOT leak data across them:

1. **Platform realm** — ``PlatformAccount``, ``PlatformLedgerEntry``.
   Visible only to PLATFORM_ADMIN. Holds the 5% commission wallet.

2. **Hotel realm** — everything carrying ``tenant_id`` (rooms, staff,
   minibar, bookings). One hotel must never see another hotel's rows.

3. **Restaurant realm** — ``Restaurant``, ``FoodItem``, ``FoodOrder``.
   Scoped by ``restaurant_id``; a restaurant owner sees only their own
   menu/orders even though the restaurant is attached to a hotel vicinity.

4. **Police realm** — ``WantedPerson``, ``PoliceMatch``. Fully isolated:
   no hotel or restaurant credential can read these tables. Matching is
   done on salted ``registry_hash`` values so raw identity documents are
   never stored.

Money & escrow
==============
Guest payments are held in escrow (``EscrowStatus``). On release, the
platform retains its commission (rate snapshotted per transaction — the
platform rate may change over time, historical rows must not) and the
remainder is credited to the hotel/restaurant. Every wallet movement is
recorded as an immutable ``PlatformLedgerEntry`` — the wallet balance is
a cache; the ledger is the source of truth.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    Enum,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import (
    Balance,
    Base,
    GeoCoordinate,
    Money,
    Rate,
    TenantScopedMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
)

# ===========================================================================
# Enumerations
# ===========================================================================
#
# All enums are native PostgreSQL ENUM types. ``values_callable`` stores the
# *values* (stable API strings) rather than Python member names, decoupling
# the wire format from Python identifier naming rules.


def _pg_enum(py_enum: type[enum.Enum], name: str) -> Enum:
    """Native PG enum that persists ``Enum.value`` strings."""
    return Enum(
        py_enum,
        name=name,
        values_callable=lambda e: [member.value for member in e],
        native_enum=True,
    )


class SubscriptionPlan(str, enum.Enum):
    """SaaS subscription tiers a hotel can purchase (in months)."""

    MONTHS_3 = "3_MONTHS"
    MONTHS_6 = "6_MONTHS"
    MONTHS_9 = "9_MONTHS"
    MONTHS_12 = "12_MONTHS"

    @property
    def months(self) -> int:
        return int(self.value.split("_", 1)[0])


class UserRole(str, enum.Enum):
    PLATFORM_ADMIN = "PLATFORM_ADMIN"      # marketplace operator staff
    HOTEL_ADMIN = "HOTEL_ADMIN"            # owns one tenant, manages staff
    MANAGER = "MANAGER"                    # hotel operations manager
    RECEPTION = "RECEPTION"                # front desk: check-in/out, bookings
    CLEANER = "CLEANER"                    # housekeeping: room state changes
    RESTAURANT_OWNER = "RESTAURANT_OWNER"  # manages one restaurant's menu/orders
    GUEST = "GUEST"                        # B2C marketplace guest (e-Mongolia SSO)


class RoomType(str, enum.Enum):
    SINGLE = "SINGLE"
    DOUBLE = "DOUBLE"
    TWIN = "TWIN"
    FAMILY = "FAMILY"
    SUITE = "SUITE"
    DELUXE = "DELUXE"


class RoomState(str, enum.Enum):
    """
    Housekeeping state machine:

        VACANT_CLEAN --(check-in)--> OCCUPIED --(check-out)--> VACANT_DIRTY
        VACANT_DIRTY --(cleaner marks done)--> VACANT_CLEAN

    Only VACANT_CLEAN rooms are sellable for same-day check-in.
    """

    VACANT_CLEAN = "VACANT_CLEAN"
    OCCUPIED = "OCCUPIED"
    VACANT_DIRTY = "VACANT_DIRTY"


class BookingStatus(str, enum.Enum):
    PENDING = "PENDING"          # created, awaiting payment
    CONFIRMED = "CONFIRMED"      # paid, escrow holds funds
    CHECKED_IN = "CHECKED_IN"
    CHECKED_OUT = "CHECKED_OUT"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


class EscrowStatus(str, enum.Enum):
    """
    Lifecycle of guest funds. Shared by ``Booking`` and ``FoodOrder``.

        NOT_FUNDED -> HELD -> RELEASED   (happy path: payee gets funds
                                          minus platform commission)
        NOT_FUNDED -> HELD -> REFUNDED   (cancellation within policy)
        HELD -> DISPUTED -> RELEASED | REFUNDED  (manual resolution)
    """

    NOT_FUNDED = "NOT_FUNDED"
    HELD = "HELD"
    RELEASED = "RELEASED"
    REFUNDED = "REFUNDED"
    DISPUTED = "DISPUTED"


class FoodOrderStatus(str, enum.Enum):
    PLACED = "PLACED"
    ACCEPTED = "ACCEPTED"
    PREPARING = "PREPARING"
    DELIVERED = "DELIVERED"
    CANCELLED = "CANCELLED"


class LedgerDirection(str, enum.Enum):
    CREDIT = "CREDIT"  # money into the platform wallet
    DEBIT = "DEBIT"    # money out of the platform wallet (payouts, refunds)


class LedgerSourceType(str, enum.Enum):
    BOOKING_COMMISSION = "BOOKING_COMMISSION"
    FOOD_ORDER_COMMISSION = "FOOD_ORDER_COMMISSION"
    MINIBAR_COMMISSION = "MINIBAR_COMMISSION"
    SUBSCRIPTION_FEE = "SUBSCRIPTION_FEE"
    PAYOUT = "PAYOUT"
    REFUND = "REFUND"
    MANUAL_ADJUSTMENT = "MANUAL_ADJUSTMENT"


class PoliceMatchStatus(str, enum.Enum):
    PENDING_REVIEW = "PENDING_REVIEW"
    CONFIRMED = "CONFIRMED"
    DISMISSED = "DISMISSED"


class WantedPersonStatus(str, enum.Enum):
    """Lifecycle of a watchlist entry (descriptive; ``is_active`` remains
    the flag the matcher actually gates on)."""

    WANTED = "WANTED"
    ARRESTED = "ARRESTED"
    CLEARED = "CLEARED"      # de-listed / false lead


class PoliceResolutionAction(str, enum.Enum):
    """What an officer did with a match when resolving it."""

    ARRESTED = "ARRESTED"    # genuine hit + suspect apprehended
    CONFIRMED = "CONFIRMED"  # genuine hit, no arrest (yet)
    DISMISSED = "DISMISSED"  # false positive


class ContactRequestStatus(str, enum.Enum):
    """Sales pipeline for hotel onboarding leads."""

    NEW = "NEW"                # just submitted, nobody has looked at it
    CONTACTED = "CONTACTED"    # sales reached out
    CONVERTED = "CONVERTED"    # became a Tenant (created manually by admin)
    REJECTED = "REJECTED"      # spam / not a fit


# ===========================================================================
# Platform realm
# ===========================================================================
class PlatformAccount(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    The platform's commission wallet (singleton).

    ``balance`` is a materialised cache of ``SUM(ledger entries)`` kept
    consistent inside the same transaction that inserts the ledger row
    (``SELECT ... FOR UPDATE`` on this row first). Reconciliation jobs
    compare the two and alarm on drift.
    """

    __tablename__ = "platform_accounts"
    __table_args__ = (
        CheckConstraint("balance >= 0", name="balance_non_negative"),
        CheckConstraint(
            "commission_rate >= 0 AND commission_rate <= 0.5",
            name="commission_rate_sane",
        ),
        # Singleton guard: a fixed-value unique column makes a second row
        # physically impossible, without magic hard-coded UUIDs.
        Index(
            "uq_platform_accounts_singleton",
            text("(true)"),
            unique=True,
        ),
    )

    #: ISO-4217 settlement currency.
    currency: Mapped[str] = mapped_column(String(3), default="MNT")
    #: Cached wallet balance — ledger is authoritative.
    balance: Mapped[Balance] = mapped_column(default=Decimal("0.00"))
    #: Current commission rate applied to NEW transactions (5% default).
    #: Historical transactions keep their own snapshotted rate.
    commission_rate: Mapped[Rate] = mapped_column(default=Decimal("0.0500"))

    ledger_entries: Mapped[list["PlatformLedgerEntry"]] = relationship(
        back_populates="account",
        order_by="PlatformLedgerEntry.created_at",
    )


class PlatformLedgerEntry(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    Append-only double-entry record of every platform wallet movement.

    Rows are NEVER updated or deleted; corrections are compensating
    entries (``MANUAL_ADJUSTMENT``). ``balance_after`` snapshots the
    wallet balance at write time so audits do not require replaying
    the full ledger.
    """

    __tablename__ = "platform_ledger_entries"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("platform_accounts.id", ondelete="RESTRICT"), index=True
    )
    direction: Mapped[LedgerDirection] = mapped_column(
        _pg_enum(LedgerDirection, "ledger_direction")
    )
    source_type: Mapped[LedgerSourceType] = mapped_column(
        _pg_enum(LedgerSourceType, "ledger_source_type")
    )
    #: Absolute amount; sign is carried by ``direction``.
    amount: Mapped[Money]
    balance_after: Mapped[Balance]
    #: Optional links back to the originating transaction.
    booking_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="SET NULL"), index=True
    )
    food_order_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("food_orders.id", ondelete="SET NULL"), index=True
    )
    note: Mapped[str | None] = mapped_column(Text)

    account: Mapped[PlatformAccount] = relationship(back_populates="ledger_entries")


class ContactRequest(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    "Contact Sales" lead from a hotel that wants to join the marketplace.

    Deliberately NOT a Tenant and NOT self-serve: because the platform is
    wired into the police realm, tenant creation is a manual, verified,
    admin-only act. This table is the entire public attack surface of
    onboarding — a name, a phone number and a NEW flag. Platform realm:
    no tenant_id, readable only by PLATFORM_ADMIN (RLS ``platform_only``).
    """

    __tablename__ = "contact_requests"

    hotel_name: Mapped[str] = mapped_column(String(160))
    contact_name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str] = mapped_column(String(32))
    status: Mapped[ContactRequestStatus] = mapped_column(
        _pg_enum(ContactRequestStatus, "contact_request_status"),
        default=ContactRequestStatus.NEW,
        index=True,  # the sales dashboard lives on WHERE status = 'NEW'
    )


# ===========================================================================
# Hotel realm
# ===========================================================================
class Tenant(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    A hotel on the marketplace — the unit of multi-tenancy.

    Every hotel-owned row in the system carries this table's ``id`` as
    ``tenant_id``; RLS pins each database session to exactly one of them.
    """

    __tablename__ = "tenants"
    __table_args__ = (
        CheckConstraint(
            "maps_lat BETWEEN -90 AND 90", name="maps_lat_range"
        ),
        CheckConstraint(
            "maps_lng BETWEEN -180 AND 180", name="maps_lng_range"
        ),
        CheckConstraint(
            "subscription_expires_at > subscription_started_at",
            name="subscription_window_valid",
        ),
        CheckConstraint(
            "wallet_balance >= 0", name="wallet_balance_non_negative"
        ),
    )

    name: Mapped[str]
    #: URL-safe identifier used in public marketplace links.
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    contact_email: Mapped[str]
    contact_phone: Mapped[str | None] = mapped_column(String(32))
    address: Mapped[str | None] = mapped_column(Text)

    #: Geolocation for map display and "restaurants in vicinity" search.
    maps_lat: Mapped[GeoCoordinate]
    maps_lng: Mapped[GeoCoordinate]

    #: SaaS subscription (3 / 6 / 9 / 12 months).
    subscription_plan: Mapped[SubscriptionPlan] = mapped_column(
        _pg_enum(SubscriptionPlan, "subscription_plan")
    )
    subscription_started_at: Mapped[datetime]
    subscription_expires_at: Mapped[datetime] = mapped_column(index=True)

    #: Soft kill-switch: expired/suspended hotels stay queryable for the
    #: platform but disappear from the public marketplace.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    #: Merchant wallet — escrow releases credit the hotel's 95% share here.
    #: Updated only under ``SELECT ... FOR UPDATE`` by the escrow service.
    wallet_balance: Mapped[Balance] = mapped_column(default=Decimal("0.00"))

    users: Mapped[list["User"]] = relationship(back_populates="tenant")
    rooms: Mapped[list["Room"]] = relationship(back_populates="tenant")
    restaurants: Mapped[list["Restaurant"]] = relationship(back_populates="tenant")


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    A staff/operator account (guests book without accounts in Phase 1).

    Realm attachment rules (enforced by ``role_realm_consistency``):
      * PLATFORM_ADMIN     -> no tenant, no restaurant
      * hotel staff roles  -> tenant_id required
      * RESTAURANT_OWNER   -> restaurant_id required (tenant_id derived
                              via the restaurant, not stored twice)
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "(role = 'PLATFORM_ADMIN' AND tenant_id IS NULL "
            " AND restaurant_id IS NULL) "
            "OR (role = 'RESTAURANT_OWNER' AND restaurant_id IS NOT NULL "
            " AND tenant_id IS NULL) "
            "OR (role IN ('HOTEL_ADMIN', 'MANAGER', 'RECEPTION', 'CLEANER') "
            " AND tenant_id IS NOT NULL AND restaurant_id IS NULL) "
            # B2C guests belong to no tenant/restaurant (marketplace-wide).
            "OR (role = 'GUEST' AND tenant_id IS NULL "
            " AND restaurant_id IS NULL)",
            name="role_realm_consistency",
        ),
    )

    email: Mapped[str] = mapped_column(String(320), unique=True)
    hashed_password: Mapped[str]
    full_name: Mapped[str]
    phone: Mapped[str | None] = mapped_column(String(32))
    role: Mapped[UserRole] = mapped_column(
        _pg_enum(UserRole, "user_role"), index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None]

    #: NULL for platform admins and restaurant owners (see check constraint).
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tenants.id", ondelete="RESTRICT"), index=True
    )
    restaurant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("restaurants.id", ondelete="RESTRICT"), index=True
    )

    tenant: Mapped[Tenant | None] = relationship(back_populates="users")
    restaurant: Mapped["Restaurant | None"] = relationship(
        back_populates="owners", foreign_keys=[restaurant_id]
    )


class Room(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """A physical, sellable hotel room."""

    __tablename__ = "rooms"
    __table_args__ = (
        CheckConstraint("beds >= 1 AND beds <= 12", name="beds_sane"),
        CheckConstraint("base_price >= 0", name="base_price_non_negative"),
        # Room numbers are unique *within* a hotel, not globally.
        Index("uq_rooms_tenant_room_number", "tenant_id", "room_number", unique=True),
    )

    room_number: Mapped[str] = mapped_column(String(16))
    room_type: Mapped[RoomType] = mapped_column(_pg_enum(RoomType, "room_type"))
    beds: Mapped[int] = mapped_column(SmallInteger)
    floor: Mapped[int] = mapped_column(SmallInteger)
    state: Mapped[RoomState] = mapped_column(
        _pg_enum(RoomState, "room_state"),
        default=RoomState.VACANT_CLEAN,
        index=True,  # housekeeping dashboards filter on state constantly
    )
    #: Nightly rate; per-booking price is snapshotted on the Booking row.
    base_price: Mapped[Money]
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    tenant: Mapped[Tenant] = relationship(back_populates="rooms")
    bookings: Mapped[list["Booking"]] = relationship(back_populates="room")


class MinibarCategory(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """Grouping for minibar items (e.g. 'Beverages', 'Snacks'). Per hotel."""

    __tablename__ = "minibar_categories"
    __table_args__ = (
        Index("uq_minibar_categories_tenant_name", "tenant_id", "name", unique=True),
    )

    name: Mapped[str] = mapped_column(String(80))
    sort_order: Mapped[int] = mapped_column(SmallInteger, default=0)

    items: Mapped[list["MinibarItem"]] = relationship(back_populates="category")


class MinibarItem(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """
    A chargeable minibar product.

    ``tenant_id`` is stored redundantly with the category's tenant on
    purpose: RLS predicates must be evaluable on the row itself without
    a join.
    """

    __tablename__ = "minibar_items"
    __table_args__ = (
        CheckConstraint("price >= 0", name="price_non_negative"),
        Index("uq_minibar_items_tenant_name", "tenant_id", "name", unique=True),
    )

    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("minibar_categories.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    price: Mapped[Money]
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    category: Mapped[MinibarCategory] = relationship(back_populates="items")


class MinibarConsumption(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """
    Minibar usage reported by housekeeping during/after a stay.

    Name and price are **snapshots** (same discipline as order lines): the
    guest owes what the item cost when consumed, whatever the manager does
    to the catalogue afterwards. Rows flip ``is_settled`` when the checkout
    settlement charges them — never deleted (audit trail).
    """

    __tablename__ = "minibar_consumptions"
    __table_args__ = (
        CheckConstraint("quantity >= 1", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
    )

    booking_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bookings.id", ondelete="RESTRICT"), index=True
    )
    minibar_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("minibar_items.id", ondelete="SET NULL")
    )
    #: Cleaner who filed the report (accountability).
    reported_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    item_name: Mapped[str] = mapped_column(String(120))
    unit_price: Mapped[Money]
    quantity: Mapped[int] = mapped_column(SmallInteger, default=1)
    #: Flipped by the checkout settlement transaction.
    is_settled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    booking: Mapped["Booking"] = relationship(back_populates="minibar_consumptions")


class Booking(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """
    A room reservation with escrowed marketplace payment.

    Financial columns are **snapshots**: room rate, commission rate and
    computed amounts are frozen at booking time so later price/rate
    changes never rewrite history.

    Double-booking is impossible at the database level: a GiST exclusion
    constraint rejects two live bookings of the same room with
    overlapping ``[check_in, check_out)`` ranges — no application lock
    or advisory-lock choreography required. (Requires ``btree_gist``.)
    """

    __tablename__ = "bookings"
    __table_args__ = (
        CheckConstraint("check_out_date > check_in_date", name="dates_ordered"),
        CheckConstraint("total_amount >= 0", name="total_non_negative"),
        CheckConstraint(
            "commission_amount >= 0 AND commission_amount <= total_amount",
            name="commission_within_total",
        ),
        ExcludeConstraint(
            (text("room_id"), "="),
            (text("daterange(check_in_date, check_out_date)"), "&&"),
            where=text("status NOT IN ('CANCELLED', 'NO_SHOW')"),
            using="gist",
            name="excl_bookings_room_date_overlap",
        ),
        Index("ix_bookings_tenant_check_in", "tenant_id", "check_in_date"),
    )

    #: Short human-readable reference for guest communication (e.g. BK-7F3A21).
    code: Mapped[str] = mapped_column(String(16), unique=True)

    room_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), index=True
    )

    # -- Guest identity (guests are unauthenticated in Phase 1) ---------- #
    guest_full_name: Mapped[str]
    guest_phone: Mapped[str] = mapped_column(String(32))
    guest_email: Mapped[str | None] = mapped_column(String(320))
    #: Salted hash of the guest's identity document, computed with
    #: ``REGISTRY_HASH_SALT``. This is the ONLY identity artefact the
    #: police-realm matcher reads — raw document numbers are never stored.
    guest_registry_hash: Mapped[str | None] = mapped_column(String(128), index=True)

    # -- Stay ------------------------------------------------------------ #
    check_in_date: Mapped[date] = mapped_column(Date)
    check_out_date: Mapped[date] = mapped_column(Date)
    status: Mapped[BookingStatus] = mapped_column(
        _pg_enum(BookingStatus, "booking_status"),
        default=BookingStatus.PENDING,
        index=True,
    )

    # -- Money (snapshotted) ---------------------------------------------- #
    nightly_rate: Mapped[Money]
    total_amount: Mapped[Money]
    commission_rate: Mapped[Rate]
    commission_amount: Mapped[Money]
    escrow_status: Mapped[EscrowStatus] = mapped_column(
        _pg_enum(EscrowStatus, "escrow_status"),
        default=EscrowStatus.NOT_FUNDED,
        index=True,
    )
    paid_at: Mapped[datetime | None]
    escrow_settled_at: Mapped[datetime | None]
    #: QPay invoice this booking is awaiting payment on. The webhook keys
    #: off this to fund the booking (production-shaped: QPay references the
    #: invoice, not our booking id). Unique so one invoice funds one stay.
    qpay_invoice_id: Mapped[str | None] = mapped_column(
        String(80), unique=True, index=True
    )

    room: Mapped[Room] = relationship(back_populates="bookings")
    food_orders: Mapped[list["FoodOrder"]] = relationship(back_populates="booking")
    minibar_consumptions: Mapped[list[MinibarConsumption]] = relationship(
        back_populates="booking"
    )


# ===========================================================================
# Restaurant realm
# ===========================================================================
class Restaurant(UUIDPrimaryKeyMixin, TenantScopedMixin, TimestampMixin, Base):
    """
    A restaurant operating in a hotel's vicinity.

    Attached to a tenant for discovery ("food near your hotel"), but it is
    its own isolation realm: the owner manages menu and orders through
    ``restaurant_id``-scoped RLS, and hotel staff cannot edit them.
    """

    __tablename__ = "restaurants"
    __table_args__ = (
        Index("uq_restaurants_tenant_name", "tenant_id", "name", unique=True),
        CheckConstraint(
            "wallet_balance >= 0", name="wallet_balance_non_negative"
        ),
    )

    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(32))
    #: Inactive restaurants are hidden from guests; existing orders remain.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    #: Merchant wallet — escrow releases credit the restaurant's 95% here.
    wallet_balance: Mapped[Balance] = mapped_column(default=Decimal("0.00"))

    tenant: Mapped[Tenant] = relationship(back_populates="restaurants")
    owners: Mapped[list[User]] = relationship(
        back_populates="restaurant", foreign_keys=[User.restaurant_id]
    )
    food_items: Mapped[list["FoodItem"]] = relationship(back_populates="restaurant")
    food_orders: Mapped[list["FoodOrder"]] = relationship(back_populates="restaurant")


class FoodItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A menu item. Scoped by ``restaurant_id`` (restaurant realm, not hotel)."""

    __tablename__ = "food_items"
    __table_args__ = (
        CheckConstraint("price >= 0", name="price_non_negative"),
        Index("uq_food_items_restaurant_name", "restaurant_id", "name", unique=True),
    )

    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(80))
    price: Mapped[Money]
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)

    restaurant: Mapped[Restaurant] = relationship(back_populates="food_items")


class FoodOrder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    A guest food order, typically delivered to a hotel room.

    Carries BOTH scoping keys:
      * ``restaurant_id`` — the restaurant fulfils and owns the order;
      * ``tenant_id``     — the hotel it is delivered to, so reception can
        see inbound deliveries for their property (read-only via RLS).

    Escrow works exactly like bookings: funds are HELD on payment and
    RELEASED to the restaurant (minus the platform commission) after
    delivery confirmation.
    """

    __tablename__ = "food_orders"
    __table_args__ = (
        CheckConstraint("total_amount >= 0", name="total_non_negative"),
        CheckConstraint(
            "commission_amount >= 0 AND commission_amount <= total_amount",
            name="commission_within_total",
        ),
    )

    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="RESTRICT"), index=True
    )
    #: Delivery destination hotel (denormalised for RLS visibility).
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="RESTRICT"), index=True
    )
    #: Optional link to the stay that ordered it (room-charge scenarios).
    booking_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="SET NULL"), index=True
    )
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("rooms.id", ondelete="SET NULL")
    )

    status: Mapped[FoodOrderStatus] = mapped_column(
        _pg_enum(FoodOrderStatus, "food_order_status"),
        default=FoodOrderStatus.PLACED,
        index=True,
    )

    # -- Money (snapshotted, same discipline as Booking) ------------------ #
    total_amount: Mapped[Money]
    commission_rate: Mapped[Rate]
    commission_amount: Mapped[Money]
    escrow_status: Mapped[EscrowStatus] = mapped_column(
        _pg_enum(EscrowStatus, "escrow_status"),
        default=EscrowStatus.NOT_FUNDED,
        index=True,
    )
    paid_at: Mapped[datetime | None]
    escrow_settled_at: Mapped[datetime | None]

    restaurant: Mapped[Restaurant] = relationship(back_populates="food_orders")
    booking: Mapped[Booking | None] = relationship(back_populates="food_orders")
    items: Mapped[list["FoodOrderItem"]] = relationship(back_populates="order")


class FoodOrderItem(UUIDPrimaryKeyMixin, Base):
    """
    Order line item with name/price **snapshots** — menu edits after the
    fact must never change what a guest was charged.
    """

    __tablename__ = "food_order_items"
    __table_args__ = (
        CheckConstraint("quantity >= 1", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
    )

    food_order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("food_orders.id", ondelete="CASCADE"), index=True
    )
    food_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("food_items.id", ondelete="SET NULL")
    )
    #: Denormalised for RLS: line items are restaurant-realm rows too.
    restaurant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("restaurants.id", ondelete="RESTRICT"), index=True
    )
    item_name: Mapped[str] = mapped_column(String(120))
    unit_price: Mapped[Money]
    quantity: Mapped[int] = mapped_column(Integer, default=1)

    order: Mapped[FoodOrder] = relationship(back_populates="items")


# ===========================================================================
# Police realm — fully isolated; see enable_rls.sql
# ===========================================================================
class WantedPerson(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    An entry in the police wanted-persons registry.

    ``registry_hash`` is the salted hash of the person's national identity
    document — the same derivation applied to ``Booking.guest_registry_hash``
    — so matching is a pure hash-equality join and neither realm ever sees
    the other's raw documents.

    NO ``tenant_id``: this table belongs to the police realm and is
    invisible to every hotel/restaurant/platform credential (RLS default
    deny + table-level REVOKE).
    """

    __tablename__ = "wanted_persons"

    registry_hash: Mapped[str] = mapped_column(String(128), unique=True)
    full_name: Mapped[str]
    address: Mapped[str | None] = mapped_column(Text)
    #: District (дүүрэг) as returned by KHUR — a first-class dispatch field.
    district: Mapped[str | None] = mapped_column(String(120))
    case_reference: Mapped[str | None] = mapped_column(String(64))
    #: Descriptive lifecycle (WANTED -> ARRESTED / CLEARED).
    status: Mapped[WantedPersonStatus] = mapped_column(
        _pg_enum(WantedPersonStatus, "wanted_person_status"),
        default=WantedPersonStatus.WANTED,
        index=True,
    )
    #: The flag the matcher gates on. An arrest sets this False so the
    #: person stops producing new matches, while ``status`` records why.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    matches: Mapped[list["PoliceMatch"]] = relationship(
        back_populates="wanted_person"
    )


class PoliceMatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    A hit between a wanted person and a hotel booking.

    Produced by an asynchronous matcher job running under the police
    database role (comparing ``guest_registry_hash`` to active
    ``WantedPerson.registry_hash`` values). Hotels are never notified —
    only police-realm sessions can read this table.

    ``tenant_id``/``booking_id`` locate WHERE the person checked in, but
    deliberately do NOT make this a hotel-realm row: RLS grants access by
    realm, not by tenant match.
    """

    __tablename__ = "police_matches"
    __table_args__ = (
        # One open match per (person, booking) — re-runs of the matcher
        # must be idempotent.
        Index(
            "uq_police_matches_person_booking",
            "wanted_person_id",
            "booking_id",
            unique=True,
        ),
    )

    wanted_person_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("wanted_persons.id", ondelete="CASCADE"), index=True
    )
    booking_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bookings.id", ondelete="RESTRICT"), index=True
    )
    #: Hotel where the match occurred (for dispatch), police-visible only.
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tenants.id", ondelete="RESTRICT"), index=True
    )
    matched_at: Mapped[datetime]
    status: Mapped[PoliceMatchStatus] = mapped_column(
        _pg_enum(PoliceMatchStatus, "police_match_status"),
        default=PoliceMatchStatus.PENDING_REVIEW,
        index=True,
    )
    reviewed_at: Mapped[datetime | None]
    review_note: Mapped[str | None] = mapped_column(Text)

    wanted_person: Mapped[WantedPerson] = relationship(back_populates="matches")


class PoliceOfficer(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    A police officer account — the police realm's OWN identity store.

    Deliberately NOT a row in ``users``: police principals are not hotel
    staff, the ``UserRole`` enum has no POLICE member, and the police realm
    must stay isolated from the app's user table. Only ``police_runtime``
    (realm='police') can read this table; app credentials hold no grants.
    """

    __tablename__ = "police_officers"

    badge_number: Mapped[str] = mapped_column(String(32), unique=True)
    hashed_password: Mapped[str]
    full_name: Mapped[str]
    rank: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None]

    audit_logs: Mapped[list["PoliceAuditLog"]] = relationship(
        back_populates="officer"
    )


class PoliceAuditLog(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """
    Append-only record of officer actions (arrests, dismissals, watchlist
    edits). Police-realm only; never updated or deleted.

    ``officer_id`` is ``SET NULL`` on officer deletion so the historical
    action survives even if the account is later removed.
    """

    __tablename__ = "police_audit_logs"

    officer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("police_officers.id", ondelete="SET NULL"), index=True
    )
    action: Mapped[str] = mapped_column(String(64), index=True)
    #: Who the action was about (a watchlist entry), if applicable.
    target_person_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("wanted_persons.id", ondelete="SET NULL"), index=True
    )
    #: The match that triggered the action, if applicable.
    match_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("police_matches.id", ondelete="SET NULL")
    )
    note: Mapped[str | None] = mapped_column(Text)

    officer: Mapped["PoliceOfficer | None"] = relationship(
        back_populates="audit_logs"
    )
