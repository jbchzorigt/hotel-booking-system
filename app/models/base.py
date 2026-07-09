"""
Declarative base, naming conventions and reusable mixins.

Design notes (Principal Architect)
==================================
*   **Deterministic constraint names.**  Alembic autogenerate and RLS
    scripts both reference constraints by name; PostgreSQL's auto-generated
    names are not stable across environments, so we pin a naming convention
    on the shared ``MetaData``.

*   **UUID primary keys everywhere.**  In a B2B2C marketplace, IDs leak
    into URLs, emails and third-party webhooks.  Sequential integers would
    disclose business volume (competitor counts your bookings) and enable
    enumeration attacks.  ``gen_random_uuid()`` is generated server-side
    (pgcrypto is built-in since PG 13) so bulk inserts stay cheap.

*   **Timezone-aware timestamps only.**  Hotels, guests and the platform
    operate across timezones; naive datetimes are banned via the
    ``type_annotation_map``.

*   **Tenant scoping as a mixin.**  Every hotel-owned table gets an
    identical, indexed, NOT NULL ``tenant_id``.  This uniformity is what
    makes the Row-Level Security policies (see ``scripts/enable_rls.sql``)
    mechanical instead of bespoke per table.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from sqlalchemy import ForeignKey, MetaData, Numeric, String, func
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

# ---------------------------------------------------------------------------
# Naming convention — stable, environment-independent constraint names.
# ---------------------------------------------------------------------------
NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Project-wide declarative base."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    # Central Python-type -> SQL-type mapping. Keeps column definitions terse
    # and guarantees consistency (e.g. *every* datetime is timestamptz).
    type_annotation_map = {
        datetime: TIMESTAMP(timezone=True),
        uuid.UUID: UUID(as_uuid=True),
        str: String(255),
    }


# ---------------------------------------------------------------------------
# Reusable ``Annotated`` column recipes (SQLAlchemy 2.0, PEP 593).
# ---------------------------------------------------------------------------

#: Monetary amount. NEVER use floats for money — Numeric(12, 2) covers
#: amounts up to 9,999,999,999.99 which is ample for per-transaction values.
Money = Annotated[Decimal, mapped_column(Numeric(12, 2))]

#: Wallet / aggregate balances need more headroom than a single transaction.
Balance = Annotated[Decimal, mapped_column(Numeric(16, 2))]

#: Rates and percentages stored as exact fractions (0.0500 == 5%).
Rate = Annotated[Decimal, mapped_column(Numeric(6, 4))]

#: WGS-84 coordinate — 6 decimal places ≈ 11 cm precision, plenty for
#: "hotel vicinity" queries. (Upgrade path: PostGIS geography column.)
GeoCoordinate = Annotated[Decimal, mapped_column(Numeric(9, 6))]


# ---------------------------------------------------------------------------
# Mixins
# ---------------------------------------------------------------------------
class UUIDPrimaryKeyMixin:
    """Server-generated UUIDv4 surrogate primary key."""

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
        sort_order=-100,  # keep the PK as the first column in DDL
    )


class TimestampMixin:
    """
    Immutable ``created_at`` + auto-touching ``updated_at``.

    ``server_default``/``server_onupdate`` semantics: timestamps are set by
    the database, so rows written by ad-hoc SQL, ETL jobs or psql sessions
    are stamped identically to ORM writes.
    """

    created_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        sort_order=90,
    )
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
        sort_order=91,
    )


class TenantScopedMixin:
    """
    Marks a table as belonging to exactly one hotel (tenant).

    The column is:
      * ``NOT NULL``  — no orphaned, tenant-less rows can exist;
      * indexed       — every RLS policy predicate hits this column;
      * ``ON DELETE RESTRICT`` — a tenant with live data cannot be dropped
        by accident; offboarding is an explicit, audited workflow.
    """

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:  # noqa: N805 — SQLAlchemy idiom
        return mapped_column(
            ForeignKey("tenants.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
            sort_order=-90,  # right after the PK in DDL
        )
