"""ORM models for spec §6. Column convention: `org_id` everywhere.

Cross-organization references are prevented by composite (org_id, id) foreign keys on the
operational tables, so a row can never point at another organization's aggregate.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def ts_created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def ts_updated() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


def org_fk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False)


def scoped_fk(cols: list[str], table: str, name: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(["org_id", *cols], [f"{table}.org_id", f"{table}.id"], name=name)


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = ts_created()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = uuid_pk()
    keycloak_subject: Mapped[str] = mapped_column(String(255), unique=True)
    display_name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(320))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = ts_created()


class Membership(Base):
    """Organization role. Roles are coarse; permissions are resolved in app.core.permissions."""

    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_membership_org_user"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(40))  # camp_operator | trek_leader | supervisor | administrator
    org_wide: Mapped[bool] = mapped_column(Boolean, default=False)
    extra_permissions: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    scope_epoch: Mapped[int] = mapped_column(BigInteger, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Camp(Base):
    __tablename__ = "camps"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_camps_org_id"),
        UniqueConstraint("org_id", "code", name="uq_camps_org_code"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class CampMembership(Base):
    __tablename__ = "camp_memberships"
    __table_args__ = (
        UniqueConstraint("org_id", "user_id", "camp_id", name="uq_camp_membership"),
        scoped_fk(["camp_id"], "camps", "fk_campmem_camp"),
        Index("ix_campmem_user", "org_id", "user_id"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    camp_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    permissions: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    access_epoch: Mapped[int] = mapped_column(BigInteger, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Location(Base):
    __tablename__ = "locations"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_locations_org_id"),
        UniqueConstraint("org_id", "camp_id", "label", name="uq_location_label"),
        scoped_fk(["camp_id"], "camps", "fk_location_camp"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    camp_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    label: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(40), default="STORE")  # STORE | RACK | REPAIR_BENCH
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("org_id", "installation_id", "user_id", name="uq_device_install"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    platform: Mapped[str] = mapped_column(String(20))
    installation_id: Mapped[str] = mapped_column(String(128))
    label: Mapped[str | None] = mapped_column(String(120))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reported_pending: Mapped[int | None] = mapped_column(Integer)
    reported_pending_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = ts_created()


class TrekBatch(Base):
    __tablename__ = "trek_batches"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_batches_org_id"),
        UniqueConstraint("org_id", "code", name="uq_batch_code"),
        scoped_fk(["camp_id"], "camps", "fk_batch_camp"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str] = mapped_column(String(60))
    trek_name: Mapped[str] = mapped_column(String(120))
    camp_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    external_id: Mapped[str | None] = mapped_column(String(120))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Trekker(Base):
    """Minimal personal data: display name only (spec §24)."""

    __tablename__ = "trekkers"
    __table_args__ = (UniqueConstraint("org_id", "id", name="uq_trekkers_org_id"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    display_name: Mapped[str] = mapped_column(String(200))
    size_hint: Mapped[str | None] = mapped_column(String(20))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    external_id: Mapped[str | None] = mapped_column(String(120))


class BatchMember(Base):
    __tablename__ = "batch_members"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_batchmem_org_id"),
        UniqueConstraint("org_id", "batch_id", "trekker_id", name="uq_batch_member"),
        scoped_fk(["batch_id"], "trek_batches", "fk_bm_batch"),
        scoped_fk(["trekker_id"], "trekkers", "fk_bm_trekker"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    batch_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    trekker_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    gear_requested: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)


class EquipmentCategory(Base):
    __tablename__ = "equipment_categories"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_categories_org_id"),
        UniqueConstraint("org_id", "code", name="uq_category_code"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(120))
    group: Mapped[str] = mapped_column(String(60), default="Equipment")
    unit: Mapped[str] = mapped_column(String(20), default="item")  # item | pair
    inspect_on_return: Mapped[bool] = mapped_column(Boolean, default=True)
    image_key: Mapped[str | None] = mapped_column(String(80))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class EquipmentItem(Base):
    __tablename__ = "equipment_items"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_items_org_id"),
        UniqueConstraint("org_id", "tag", name="uq_item_tag"),
        scoped_fk(["category_id"], "equipment_categories", "fk_item_category"),
        scoped_fk(["location_id"], "locations", "fk_item_location"),
        Index(
            "ix_equipment_camp_status",
            "org_id",
            "location_id",
            "status",
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_equipment_category", "org_id", "category_id"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    tag: Mapped[str] = mapped_column(String(40))
    category_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    size: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(30), default="READY")
    location_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    notes: Mapped[str | None] = mapped_column(Text)
    last_inspected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(BigInteger, default=1)
    created_at: Mapped[datetime] = ts_created()
    updated_at: Mapped[datetime] = ts_updated()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Allocation(Base):
    __tablename__ = "allocations"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_allocations_org_id"),
        scoped_fk(["item_id"], "equipment_items", "fk_alloc_item"),
        scoped_fk(["trekker_id"], "trekkers", "fk_alloc_trekker"),
        scoped_fk(["batch_id"], "trek_batches", "fk_alloc_batch"),
        Index(
            "uq_active_allocation",
            "org_id",
            "item_id",
            unique=True,
            postgresql_where=text("state = 'ACTIVE'"),
        ),
        Index("ix_alloc_batch", "org_id", "batch_id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_id: Mapped[uuid.UUID] = org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    trekker_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    batch_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    issued_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    issued_at: Mapped[datetime] = ts_created()
    client_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_date: Mapped[date] = mapped_column(Date)
    state: Mapped[str] = mapped_column(String(20), default="ACTIVE")  # ACTIVE | RETURNED | REVERSED
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    operation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class FormDefinition(Base):
    __tablename__ = "form_definitions"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_formdef_org_id"),
        UniqueConstraint("org_id", "key", name="uq_formdef_key"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    key: Mapped[str] = mapped_column(String(80))
    title: Mapped[str] = mapped_column(String(200))
    active_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class FormVersion(Base):
    __tablename__ = "form_versions"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_formver_org_id"),
        UniqueConstraint("org_id", "definition_id", "number", name="uq_formver_number"),
        scoped_fk(["definition_id"], "form_definitions", "fk_formver_def"),
        Index(
            "uq_form_one_draft",
            "org_id",
            "definition_id",
            unique=True,
            postgresql_where=text("status = 'DRAFT'"),
        ),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    definition_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")  # DRAFT | PUBLISHED | RETIRED
    schema: Mapped[dict] = mapped_column(JSONB)
    schema_hash: Mapped[str] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Inspection(Base):
    __tablename__ = "inspections"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_inspections_org_id"),
        scoped_fk(["item_id"], "equipment_items", "fk_insp_item"),
        scoped_fk(["allocation_id"], "allocations", "fk_insp_alloc"),
        scoped_fk(["form_version_id"], "form_versions", "fk_insp_form"),
        Index("ix_insp_item_time", "org_id", "item_id", "submitted_at"),
        Index("ix_insp_alloc", "org_id", "allocation_id"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_id: Mapped[uuid.UUID] = org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    allocation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(20), default="RETURN")  # RETURN | RELEASE | RECEIPT
    form_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    answers: Mapped[dict] = mapped_column(JSONB, default=dict)
    condition: Mapped[str] = mapped_column(String(20))  # GOOD | NEEDS_REPAIR | UNUSABLE
    issue_type: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)
    evidence_state: Mapped[str] = mapped_column(String(20))  # NOT_REQUIRED | PENDING | VERIFIED | REJECTED
    submitted_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    submitted_at: Mapped[datetime] = ts_created()
    client_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Repair(Base):
    __tablename__ = "repairs"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_repairs_org_id"),
        scoped_fk(["item_id"], "equipment_items", "fk_repair_item"),
        scoped_fk(["inspection_id"], "inspections", "fk_repair_insp"),
        Index(
            "uq_open_repair",
            "org_id",
            "item_id",
            unique=True,
            postgresql_where=text(
                "state IN ('REQUESTED', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'IN_PROGRESS', 'AWAITING_RELEASE')"
            ),
        ),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    inspection_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(20), default="REPAIR")  # REPAIR | DISPOSITION
    state: Mapped[str] = mapped_column(String(30), default="REQUESTED")
    requested_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    decision_note: Mapped[str | None] = mapped_column(Text)
    started_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    completed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    work_notes: Mapped[str | None] = mapped_column(Text)
    release_inspection_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_created()
    updated_at: Mapped[datetime] = ts_updated()
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Transfer(Base):
    __tablename__ = "transfers"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_transfers_org_id"),
        scoped_fk(["from_location_id"], "locations", "fk_tr_from"),
        scoped_fk(["to_location_id"], "locations", "fk_tr_to"),
        Index("ix_tr_from", "org_id", "from_location_id", "state"),
        Index("ix_tr_to", "org_id", "to_location_id", "state"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str] = mapped_column(String(40))
    from_location_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    to_location_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    state: Mapped[str] = mapped_column(
        String(20), default="DISPATCHED"
    )  # DISPATCHED|RECEIVED|DISCREPANCY|RECONCILED
    carrier_note: Mapped[str | None] = mapped_column(Text)
    dispatched_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    dispatched_at: Mapped[datetime] = ts_created()
    received_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    receipt_notes: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class TransferLine(Base):
    __tablename__ = "transfer_lines"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_trline_org_id"),
        UniqueConstraint("org_id", "transfer_id", "item_id", name="uq_transfer_item"),
        scoped_fk(["transfer_id"], "transfers", "fk_trline_tr"),
        scoped_fk(["item_id"], "equipment_items", "fk_trline_item"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    transfer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    receipt_state: Mapped[str] = mapped_column(String(20), default="PENDING")  # PENDING|RECEIVED|MISSING
    discrepancy_reason: Mapped[str | None] = mapped_column(Text)
    resolution: Mapped[str | None] = mapped_column(String(20))  # FOUND | LOST
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class CustodyClaim(Base):
    __tablename__ = "custody_claims"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_claims_org_id"),
        scoped_fk(["item_id"], "equipment_items", "fk_claim_item"),
        Index("ix_claim_open", "org_id", "item_id", postgresql_where=text("state = 'OPEN'")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    source_type: Mapped[str] = mapped_column(
        String(30)
    )  # ALLOCATION_CONFLICT | TRANSFER_MISSING | TRANSFER_EXTRA
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    observed_location_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    description: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(20), default="OPEN")  # OPEN | RESOLVED
    resolution_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = ts_created()
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Attachment(Base):
    __tablename__ = "attachments"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_attach_org_id"),
        UniqueConstraint("object_key", name="uq_attach_key"),
        scoped_fk(["inspection_id"], "inspections", "fk_attach_insp"),
        Index("ix_attach_state", "state", "created_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_id: Mapped[uuid.UUID] = org_fk()
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    inspection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    content_hash: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(300))
    mime: Mapped[str] = mapped_column(String(40))
    bytes: Mapped[int] = mapped_column(BigInteger)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(
        String(20), default="PENDING"
    )  # PENDING|INITIATED|UPLOADED|VERIFIED|REJECTED
    rejection_reason: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = ts_created()
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class Operation(Base):
    """Durable receipt for every command (idempotency key = org_id + id)."""

    __tablename__ = "operations"
    __table_args__ = (
        PrimaryKeyConstraint("org_id", "id", name="pk_operations"),
        Index("ix_operations_received", "received_at"),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id"))
    actor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(String(60))
    payload_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(20))  # ACCEPTED | REJECTED | CONFLICT
    result: Mapped[dict] = mapped_column(JSONB)
    received_at: Mapped[datetime] = ts_created()
    client_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SyncConflict(Base):
    __tablename__ = "conflicts"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_conflicts_org_id"),
        UniqueConstraint("org_id", "operation_id", "code", name="uq_conflict_op_code"),
        scoped_fk(["item_id"], "equipment_items", "fk_conflict_item"),
        Index("ix_conflict_open", "org_id", "state"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    operation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    camp_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    code: Mapped[str] = mapped_column(String(60))
    raised_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="OPEN")  # OPEN | RESOLVED
    resolution: Mapped[str | None] = mapped_column(String(40))
    resolution_operation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = ts_created()
    version: Mapped[int] = mapped_column(BigInteger, default=1)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_aggregate", "org_id", "aggregate_type", "aggregate_id", "recorded_at"),
        Index("ix_audit_operation", "org_id", "operation_id"),
        Index("ix_audit_time", "org_id", "recorded_at"),
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id"))
    camp_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    aggregate_type: Mapped[str] = mapped_column(String(40))
    aggregate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    aggregate_version: Mapped[int | None] = mapped_column(BigInteger)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    operation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    command_type: Mapped[str | None] = mapped_column(String(60))
    request_id: Mapped[str | None] = mapped_column(String(80))
    event_type: Mapped[str] = mapped_column(String(60))
    summary: Mapped[str | None] = mapped_column(Text)
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    recorded_at: Mapped[datetime] = ts_created()
    client_recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ChangeLog(Base):
    __tablename__ = "change_log"
    __table_args__ = (
        PrimaryKeyConstraint("org_id", "sequence", name="pk_change_log"),
        Index("ix_change_entity", "org_id", "entity_type", "entity_id"),
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id"))
    sequence: Mapped[int] = mapped_column(BigInteger)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    version: Mapped[int] = mapped_column(BigInteger)
    # Visibility scopes: list of camp UUID strings, or ["*"] for org-wide reference data.
    before_scope: Mapped[list] = mapped_column(JSONB, default=list)
    after_scope: Mapped[list] = mapped_column(JSONB, default=list)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    recorded_at: Mapped[datetime] = ts_created()


class EntityScope(Base):
    """Last emitted visibility scope per entity, so the next change can compute `before_scope`."""

    __tablename__ = "entity_scopes"
    __table_args__ = (PrimaryKeyConstraint("org_id", "entity_type", "entity_id", name="pk_entity_scopes"),)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    scope: Mapped[list] = mapped_column(JSONB, default=list)


class SyncSequence(Base):
    """One row per org. Locked FOR UPDATE by every domain writer: the commit-order gate (spec §6, §18)."""

    __tablename__ = "sync_sequences"
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), primary_key=True
    )
    last_sequence: Mapped[int] = mapped_column(BigInteger, default=0)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        UniqueConstraint("unique_key", name="uq_job_key"),
        Index("ix_jobs_ready", "state", "available_at"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(String(60))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="READY")  # READY | RUNNING | DONE | FAILED
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    unique_key: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = ts_created()
