"""Scoped read endpoints (spec §8). Scope is applied before pagination."""

import base64
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal, current_principal
from app.core.db import get_session
from app.core.errors import Forbidden, NotFound
from app.core.projections import ProjectionContext
from app.core.settings import get_settings
from app.models import (
    Allocation,
    AuditEvent,
    BatchMember,
    Camp,
    CustodyClaim,
    Device,
    EquipmentCategory,
    EquipmentItem,
    FormDefinition,
    FormVersion,
    Inspection,
    Location,
    Repair,
    SyncConflict,
    Transfer,
    TransferLine,
    TrekBatch,
    Trekker,
    User,
)
from app.modules.commands.processor import get_receipt

router = APIRouter(prefix="/v1")


def _camps(principal: Principal, camp_id: uuid.UUID | None) -> list[uuid.UUID]:
    if camp_id is not None:
        if not principal.can_access_camp(camp_id):
            raise NotFound()
        return [camp_id]
    return list(principal.camp_ids)


def _enc(v: str) -> str:
    return base64.urlsafe_b64encode(v.encode()).decode()


def _dec(v: str | None) -> str | None:
    return base64.urlsafe_b64decode(v.encode()).decode() if v else None


@router.get("/me")
async def me(principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)):
    camps = (
        await session.execute(select(Camp).where(Camp.id.in_(principal.camp_ids)).order_by(Camp.name))
    ).scalars()
    user = await session.get(User, principal.user_id)
    return {
        "user": {"id": str(principal.user_id), "display_name": principal.display_name, "email": user.email},
        "org_id": str(principal.org_id),
        "role": principal.role,
        "permissions": sorted(principal.permissions),
        "org_wide": principal.org_wide,
        "camps": [
            {
                "id": str(c.id),
                "code": c.code,
                "name": c.name,
                "timezone": c.timezone,
                "extra_permissions": sorted(principal.camp_permissions.get(c.id, [])),
            }
            for c in camps
        ],
        "scope_epoch": principal.scope_epoch,
        "offline_allowance_hours": get_settings().offline_allowance_hours,
        "server_time": datetime.now(UTC).isoformat(),
    }


class DeviceIn(BaseModel):
    installation_id: str = Field(min_length=8, max_length=128)
    platform: str = Field(pattern=r"^(android|ios|web)$")
    label: str | None = Field(default=None, max_length=120)


@router.post("/devices")
async def register_device(
    body: DeviceIn,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    async with session.begin():
        dev = (
            await session.execute(
                select(Device).where(
                    Device.org_id == principal.org_id,
                    Device.user_id == principal.user_id,
                    Device.installation_id == body.installation_id,
                )
            )
        ).scalar_one_or_none()
        if dev is None:
            dev = Device(
                org_id=principal.org_id,
                user_id=principal.user_id,
                platform=body.platform,
                installation_id=body.installation_id,
                label=body.label,
                enabled=True,
            )
            session.add(dev)
        dev.last_seen_at = datetime.now(UTC)
        await session.flush()
        if not dev.enabled:
            raise Forbidden("This device has been disabled.", "DEVICE_DISABLED")
        return {"device_id": str(dev.id), "enabled": dev.enabled}


@router.get("/devices")
async def list_devices(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    if "dashboard.read" not in principal.permissions:
        raise Forbidden()
    rows = (
        await session.execute(
            select(Device, User.display_name)
            .join(User, User.id == Device.user_id)
            .where(Device.org_id == principal.org_id)
            .order_by(Device.last_seen_at.desc().nulls_last())
        )
    ).all()
    return {
        "items": [
            {
                "id": str(d.id),
                "user": name,
                "platform": d.platform,
                "label": d.label,
                "enabled": d.enabled,
                "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None,
                # Only what the device itself reported; never inferred (spec §21).
                "reported_pending": d.reported_pending,
                "reported_pending_at": d.reported_pending_at.isoformat() if d.reported_pending_at else None,
            }
            for d, name in rows
        ]
    }


@router.get("/camps")
async def camps(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    rows = (
        await session.execute(select(Camp).where(Camp.id.in_(principal.camp_ids)).order_by(Camp.name))
    ).scalars()
    out = []
    for c in rows:
        locs = (await session.execute(select(Location).where(Location.camp_id == c.id))).scalars()
        out.append(
            {
                "id": str(c.id),
                "code": c.code,
                "name": c.name,
                "timezone": c.timezone,
                "locations": [{"id": str(loc_.id), "label": loc_.label, "type": loc_.type} for loc_ in locs],
            }
        )
    return {"items": out}


@router.get("/locations")
async def all_locations(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    """Destination picker for handovers: every org location (labels only, no inventory)."""
    rows = (
        await session.execute(
            select(Location, Camp.name)
            .join(Camp, Camp.id == Location.camp_id)
            .where(Location.org_id == principal.org_id)
        )
    ).all()
    return {
        "items": [
            {"id": str(loc_.id), "label": loc_.label, "camp_id": str(loc_.camp_id), "camp_name": n}
            for loc_, n in rows
        ]
    }


@router.get("/categories")
async def categories(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    rows = (
        await session.execute(
            select(EquipmentCategory)
            .where(EquipmentCategory.org_id == principal.org_id)
            .order_by(EquipmentCategory.name)
        )
    ).scalars()
    return {
        "items": [
            {
                "id": str(c.id),
                "code": c.code,
                "name": c.name,
                "group": c.group,
                "unit": c.unit,
                "image_key": c.image_key,
            }
            for c in rows
        ]
    }


@router.get("/batches")
async def batches(
    camp_id: uuid.UUID | None = None,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    rows = (
        await session.execute(
            select(TrekBatch)
            .where(TrekBatch.org_id == principal.org_id, TrekBatch.camp_id.in_(_camps(principal, camp_id)))
            .order_by(TrekBatch.start_date)
        )
    ).scalars()
    return {
        "items": [
            {
                "id": str(b.id),
                "code": b.code,
                "trek_name": b.trek_name,
                "camp_id": str(b.camp_id),
                "start_date": b.start_date.isoformat(),
                "end_date": b.end_date.isoformat(),
                "active": b.active,
            }
            for b in rows
        ]
    }


@router.get("/batches/{batch_id}/members")
async def batch_members(
    batch_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    b = await session.get(TrekBatch, batch_id)
    if b is None or b.org_id != principal.org_id or not principal.can_access_camp(b.camp_id):
        raise NotFound()
    rows = (
        await session.execute(
            select(BatchMember, Trekker)
            .join(Trekker, Trekker.id == BatchMember.trekker_id)
            .where(BatchMember.batch_id == batch_id)
            .order_by(Trekker.display_name)
        )
    ).all()
    return {
        "items": [
            {
                "trekker_id": str(t.id),
                "display_name": t.display_name,
                "size_hint": t.size_hint,
                "gear_requested": m.gear_requested,
            }
            for m, t in rows
        ]
    }


async def _equipment_rows(session: AsyncSession, items: list[EquipmentItem]) -> list[dict[str, Any]]:
    if not items:
        return []
    ids = [i.id for i in items]
    cats = {c.id: c for c in (await session.execute(select(EquipmentCategory))).scalars()}
    locs = {loc_.id: loc_ for loc_ in (await session.execute(select(Location))).scalars()}
    camps = {c.id: c for c in (await session.execute(select(Camp))).scalars()}
    allocs = {
        a.item_id: (a, t, b)
        for a, t, b in (
            await session.execute(
                select(Allocation, Trekker, TrekBatch)
                .join(Trekker, Trekker.id == Allocation.trekker_id)
                .join(TrekBatch, TrekBatch.id == Allocation.batch_id)
                .where(Allocation.item_id.in_(ids), Allocation.state == "ACTIVE")
            )
        ).all()
    }
    claims: dict[uuid.UUID, int] = dict(
        (
            await session.execute(
                select(CustodyClaim.item_id, func.count())
                .where(CustodyClaim.item_id.in_(ids), CustodyClaim.state == "OPEN")
                .group_by(CustodyClaim.item_id)
            )
        ).all()
    )
    conflicts: dict[uuid.UUID, int] = dict(
        (
            await session.execute(
                select(SyncConflict.item_id, func.count())
                .where(SyncConflict.item_id.in_(ids), SyncConflict.state == "OPEN")
                .group_by(SyncConflict.item_id)
            )
        ).all()
    )
    out = []
    for i in items:
        c = cats[i.category_id]
        loc = locs[i.location_id]
        a = allocs.get(i.id)
        out.append(
            {
                "id": str(i.id),
                "tag": i.tag,
                "status": i.status,
                "size": i.size,
                "version": i.version,
                "category": {
                    "id": str(c.id),
                    "name": c.name,
                    "group": c.group,
                    "code": c.code,
                    "image_key": c.image_key,
                },
                "location": {
                    "id": str(loc.id),
                    "label": loc.label,
                    "camp_id": str(loc.camp_id),
                    "camp_name": camps[loc.camp_id].name,
                },
                "allocation": {
                    "id": str(a[0].id),
                    "trekker_name": a[1].display_name,
                    "batch_code": a[2].code,
                    "trek_name": a[2].trek_name,
                    "due_date": a[0].due_date.isoformat(),
                }
                if a
                else None,
                "open_claims": claims.get(i.id, 0),
                "open_conflicts": conflicts.get(i.id, 0),
                "updated_at": i.updated_at.isoformat(),
            }
        )
    return out


@router.get("/equipment")
async def equipment(
    camp_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    status: str | None = None,
    category_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=60),
    exceptions_only: bool = False,
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    principal.require("equipment.read")
    camp_ids = _camps(principal, camp_id)
    stmt = (
        select(EquipmentItem)
        .join(Location, Location.id == EquipmentItem.location_id)
        .join(EquipmentCategory, EquipmentCategory.id == EquipmentItem.category_id)
        .where(
            EquipmentItem.org_id == principal.org_id,
            Location.camp_id.in_(camp_ids),
            EquipmentItem.deleted_at.is_(None),
        )
    )
    if location_id:
        stmt = stmt.where(EquipmentItem.location_id == location_id)
    if status:
        stmt = stmt.where(EquipmentItem.status.in_(status.split(",")))
    if category_id:
        stmt = stmt.where(EquipmentItem.category_id == category_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                EquipmentItem.tag.ilike(like),
                EquipmentCategory.name.ilike(like),
                EquipmentCategory.group.ilike(like),
            )
        )
    if exceptions_only:
        stmt = stmt.where(
            or_(
                EquipmentItem.status.in_(["MISSING", "QUARANTINED", "REPAIR_PENDING"]),
                EquipmentItem.id.in_(select(SyncConflict.item_id).where(SyncConflict.state == "OPEN")),
            )
        )
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar()
    after = _dec(cursor)
    if after:
        stmt = stmt.where(EquipmentItem.tag > after)
    items = (await session.execute(stmt.order_by(EquipmentItem.tag).limit(limit + 1))).scalars().all()
    more = len(items) > limit
    items = items[:limit]
    counts = dict(
        (
            await session.execute(
                select(EquipmentItem.status, func.count())
                .join(Location, Location.id == EquipmentItem.location_id)
                .where(EquipmentItem.org_id == principal.org_id, Location.camp_id.in_(camp_ids))
                .group_by(EquipmentItem.status)
            )
        ).all()
    )
    return {
        "items": await _equipment_rows(session, items),
        "total": total,
        "status_counts": counts,
        "next_cursor": _enc(items[-1].tag) if more else None,
    }


async def _scoped_item(
    session: AsyncSession, principal: Principal, item: EquipmentItem | None
) -> EquipmentItem:
    if item is None or item.org_id != principal.org_id:
        raise NotFound()
    camps = await ProjectionContext(session).item_camps(item)
    if not any(principal.can_access_camp(uuid.UUID(c)) for c in camps):
        raise NotFound()
    return item


@router.get("/equipment/by-tag/{tag}")
async def equipment_by_tag(
    tag: str, principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    item = (
        await session.execute(
            select(EquipmentItem).where(
                EquipmentItem.org_id == principal.org_id, EquipmentItem.tag == tag.upper()
            )
        )
    ).scalar_one_or_none()
    item = await _scoped_item(session, principal, item)
    return await equipment_detail(item.id, principal, session)


@router.get("/equipment/{item_id}")
async def equipment_detail(
    item_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    item = await _scoped_item(session, principal, await session.get(EquipmentItem, item_id))
    row = (await _equipment_rows(session, [item]))[0]
    repair = (
        await session.execute(
            select(Repair).where(Repair.item_id == item.id).order_by(Repair.created_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    insp = (
        await session.execute(
            select(Inspection)
            .where(Inspection.item_id == item.id)
            .order_by(Inspection.submitted_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    claims = (
        (
            await session.execute(
                select(CustodyClaim).where(CustodyClaim.item_id == item.id, CustodyClaim.state == "OPEN")
            )
        )
        .scalars()
        .all()
    )
    proj = ProjectionContext(session)
    row["repair"] = await proj.serialize("repair", repair) if repair else None
    row["last_inspection"] = await proj.serialize("inspection", insp) if insp else None
    row["custody_claims"] = [await proj.serialize("custody_claim", c) for c in claims]
    row["notes"] = item.notes
    return row


@router.get("/equipment/{item_id}/history")
async def equipment_history(
    item_id: uuid.UUID,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    item = await _scoped_item(session, principal, await session.get(EquipmentItem, item_id))
    related = [item.id]
    related += (
        (await session.execute(select(Allocation.id).where(Allocation.item_id == item.id))).scalars().all()
    )
    related += (await session.execute(select(Repair.id).where(Repair.item_id == item.id))).scalars().all()
    related += (
        (await session.execute(select(Inspection.id).where(Inspection.item_id == item.id))).scalars().all()
    )
    stmt = (
        select(AuditEvent, User.display_name)
        .outerjoin(User, User.id == AuditEvent.actor_id)
        .where(AuditEvent.org_id == principal.org_id, AuditEvent.aggregate_id.in_(related))
    )
    if cursor:
        stmt = stmt.where(AuditEvent.id < int(_dec(cursor)))
    rows = (await session.execute(stmt.order_by(AuditEvent.id.desc()).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [_audit_row(e, n) for e, n in rows],
        "next_cursor": _enc(str(rows[-1][0].id)) if more else None,
    }


def _audit_row(e: AuditEvent, actor: str | None) -> dict:
    return {
        "id": e.id,
        "aggregate_type": e.aggregate_type,
        "aggregate_id": str(e.aggregate_id),
        "aggregate_version": e.aggregate_version,
        "event_type": e.event_type,
        "summary": e.summary,
        "actor_id": str(e.actor_id) if e.actor_id else None,
        "actor_name": actor,
        "operation_id": str(e.operation_id) if e.operation_id else None,
        "command_type": e.command_type,
        "request_id": e.request_id,
        "before": e.before,
        "after": e.after,
        "recorded_at": e.recorded_at.isoformat(),
        "client_recorded_at": e.client_recorded_at.isoformat() if e.client_recorded_at else None,
    }


@router.get("/audit-events")
async def audit_events(
    aggregate_id: uuid.UUID | None = None,
    operation_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
    event_type: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    cursor: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    principal.require("audit.read")
    stmt = (
        select(AuditEvent, User.display_name)
        .outerjoin(User, User.id == AuditEvent.actor_id)
        .where(AuditEvent.org_id == principal.org_id)
    )
    if not principal.org_wide:
        stmt = stmt.where(or_(AuditEvent.camp_id.in_(principal.camp_ids), AuditEvent.camp_id.is_(None)))
    for col, val in (
        (AuditEvent.aggregate_id, aggregate_id),
        (AuditEvent.operation_id, operation_id),
        (AuditEvent.actor_id, actor_id),
        (AuditEvent.event_type, event_type),
    ):
        if val is not None:
            stmt = stmt.where(col == val)
    if since:
        stmt = stmt.where(AuditEvent.recorded_at >= since)
    if until:
        stmt = stmt.where(AuditEvent.recorded_at < until)
    if cursor:
        stmt = stmt.where(AuditEvent.id < int(_dec(cursor)))
    rows = (await session.execute(stmt.order_by(AuditEvent.id.desc()).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [_audit_row(e, n) for e, n in rows],
        "next_cursor": _enc(str(rows[-1][0].id)) if more else None,
    }


@router.get("/transfers")
async def transfers(
    camp_id: uuid.UUID | None = None,
    state: str | None = None,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    camp_ids = _camps(principal, camp_id)
    loc_ids = select(Location.id).where(Location.camp_id.in_(camp_ids))
    stmt = select(Transfer).where(
        Transfer.org_id == principal.org_id,
        or_(Transfer.from_location_id.in_(loc_ids), Transfer.to_location_id.in_(loc_ids)),
    )
    if state:
        stmt = stmt.where(Transfer.state.in_(state.split(",")))
    rows = (await session.execute(stmt.order_by(Transfer.dispatched_at.desc()).limit(200))).scalars().all()
    locs = {loc_.id: loc_ for loc_ in (await session.execute(select(Location))).scalars()}
    out = []
    for t in rows:
        lines = (
            await session.execute(
                select(TransferLine, EquipmentItem.tag)
                .join(EquipmentItem, EquipmentItem.id == TransferLine.item_id)
                .where(TransferLine.transfer_id == t.id)
                .order_by(EquipmentItem.tag)
            )
        ).all()
        out.append(
            {
                "id": str(t.id),
                "code": t.code,
                "state": t.state,
                "version": t.version,
                "from": {"id": str(t.from_location_id), "label": locs[t.from_location_id].label},
                "to": {"id": str(t.to_location_id), "label": locs[t.to_location_id].label},
                "dispatched_at": t.dispatched_at.isoformat(),
                "received_at": t.received_at.isoformat() if t.received_at else None,
                "carrier_note": t.carrier_note,
                "receipt_notes": t.receipt_notes,
                "lines": [
                    {
                        "id": str(ln.id),
                        "item_id": str(ln.item_id),
                        "tag": tag,
                        "receipt_state": ln.receipt_state,
                        "discrepancy_reason": ln.discrepancy_reason,
                        "resolution": ln.resolution,
                    }
                    for ln, tag in lines
                ],
            }
        )
    return {"items": out}


@router.get("/repairs")
async def repairs(
    state: str | None = None,
    camp_id: uuid.UUID | None = None,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    camp_ids = _camps(principal, camp_id)
    stmt = (
        select(Repair, EquipmentItem, Inspection)
        .join(EquipmentItem, EquipmentItem.id == Repair.item_id)
        .join(Location, Location.id == EquipmentItem.location_id)
        .outerjoin(Inspection, Inspection.id == Repair.inspection_id)
        .where(Repair.org_id == principal.org_id, Location.camp_id.in_(camp_ids))
    )
    if state:
        stmt = stmt.where(Repair.state.in_(state.split(",")))
    rows = (await session.execute(stmt.order_by(Repair.created_at.desc()).limit(200))).all()
    users = {u.id: u.display_name for u in (await session.execute(select(User))).scalars()}
    from app.models import Attachment

    out = []
    for r, item, insp in rows:
        atts = []
        if insp is not None:
            atts = (
                (await session.execute(select(Attachment).where(Attachment.inspection_id == insp.id)))
                .scalars()
                .all()
            )
        out.append(
            {
                "id": str(r.id),
                "state": r.state,
                "kind": r.kind,
                "version": r.version,
                "item": {"id": str(item.id), "tag": item.tag, "status": item.status, "version": item.version},
                "inspection": {
                    "id": str(insp.id),
                    "condition": insp.condition,
                    "issue_type": insp.issue_type,
                    "notes": insp.notes,
                    "evidence_state": insp.evidence_state,
                    "submitted_at": insp.submitted_at.isoformat(),
                    "submitted_by": users.get(insp.submitted_by),
                    "attachments": [
                        {"id": str(a.id), "state": a.state, "reason": a.rejection_reason} for a in atts
                    ],
                }
                if insp
                else None,
                "requested_by": users.get(r.requested_by),
                "decision_note": r.decision_note,
                "work_notes": r.work_notes,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
        )
    return {"items": out}


@router.get("/conflicts")
async def conflicts(
    state: str = "OPEN",
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    rows = (
        await session.execute(
            select(SyncConflict, EquipmentItem.tag)
            .join(EquipmentItem, EquipmentItem.id == SyncConflict.item_id)
            .where(
                SyncConflict.org_id == principal.org_id,
                SyncConflict.camp_id.in_(principal.camp_ids),
                SyncConflict.state.in_(state.split(",")),
            )
            .order_by(SyncConflict.created_at.desc())
        )
    ).all()
    claims = (
        await session.execute(
            select(CustodyClaim, EquipmentItem.tag)
            .join(EquipmentItem, EquipmentItem.id == CustodyClaim.item_id)
            .join(Location, Location.id == EquipmentItem.location_id)
            .where(
                CustodyClaim.org_id == principal.org_id,
                CustodyClaim.state == "OPEN",
                Location.camp_id.in_(principal.camp_ids),
            )
        )
    ).all()
    proj = ProjectionContext(session)
    return {
        "conflicts": [{**await proj.serialize("conflict", c), "item_tag": tag} for c, tag in rows],
        "custody_claims": [
            {**await proj.serialize("custody_claim", c), "item_tag": tag} for c, tag in claims
        ],
    }


@router.get("/dashboard")
async def dashboard(
    camp_id: uuid.UUID | None = None,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    """Server-derived counts. Knows nothing about unsent changes on disconnected devices (spec §10)."""
    camp_ids = _camps(principal, camp_id)
    loc_ids = select(Location.id).where(Location.camp_id.in_(camp_ids))
    status_counts = dict(
        (
            await session.execute(
                select(EquipmentItem.status, func.count())
                .where(EquipmentItem.location_id.in_(loc_ids))
                .group_by(EquipmentItem.status)
            )
        ).all()
    )
    active_allocations = (
        await session.execute(
            select(func.count())
            .select_from(Allocation)
            .join(TrekBatch, TrekBatch.id == Allocation.batch_id)
            .where(Allocation.state == "ACTIVE", TrekBatch.camp_id.in_(camp_ids))
        )
    ).scalar()
    pending_repairs = (
        await session.execute(
            select(func.count())
            .select_from(Repair)
            .join(EquipmentItem, EquipmentItem.id == Repair.item_id)
            .where(
                Repair.state.in_(["REQUESTED", "MORE_INFORMATION_REQUIRED"]),
                EquipmentItem.location_id.in_(loc_ids),
            )
        )
    ).scalar()
    open_conflicts = (
        await session.execute(
            select(func.count())
            .select_from(SyncConflict)
            .where(SyncConflict.state == "OPEN", SyncConflict.camp_id.in_(camp_ids))
        )
    ).scalar()
    incoming = (
        await session.execute(
            select(func.count())
            .select_from(Transfer)
            .where(Transfer.state == "DISPATCHED", Transfer.to_location_id.in_(loc_ids))
        )
    ).scalar()
    devices = (
        (
            await session.execute(
                select(Device).where(Device.org_id == principal.org_id, Device.reported_pending > 0)
            )
        )
        .scalars()
        .all()
    )
    return {
        "status_counts": status_counts,
        "item_total": sum(status_counts.values()),
        "active_allocations": active_allocations,
        "repairs_awaiting_decision": pending_repairs,
        "open_conflicts": open_conflicts,
        "incoming_handovers": incoming,
        "devices_reporting_pending": len(devices),
        "generated_at": datetime.now(UTC).isoformat(),
    }


@router.get("/forms")
async def forms(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    defs = (
        await session.execute(select(FormDefinition).where(FormDefinition.org_id == principal.org_id))
    ).scalars()
    out = []
    for d in defs:
        versions = (
            (
                await session.execute(
                    select(FormVersion)
                    .where(FormVersion.definition_id == d.id)
                    .order_by(FormVersion.number.desc())
                )
            )
            .scalars()
            .all()
        )
        if "forms.edit" not in principal.permissions:
            versions = [v for v in versions if v.status != "DRAFT"]
        out.append(
            {
                "id": str(d.id),
                "key": d.key,
                "title": d.title,
                "version": d.version,
                "active_version_id": str(d.active_version_id) if d.active_version_id else None,
                "versions": [
                    {
                        "id": str(v.id),
                        "number": v.number,
                        "status": v.status,
                        "schema": v.schema,
                        "schema_hash": v.schema_hash,
                        "version": v.version,
                        "published_at": v.published_at.isoformat() if v.published_at else None,
                    }
                    for v in versions
                ],
            }
        )
    return {"items": out}


@router.get("/forms/{key}/versions/{number}")
async def form_version(
    key: str,
    number: int,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    row = (
        await session.execute(
            select(FormVersion)
            .join(FormDefinition, FormDefinition.id == FormVersion.definition_id)
            .where(
                FormDefinition.org_id == principal.org_id,
                FormDefinition.key == key,
                FormVersion.number == number,
                FormVersion.status != "DRAFT",
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound()
    return await ProjectionContext(session).serialize("form_version", row)


@router.get("/operations/{operation_id}")
async def operation(
    operation_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    r = await get_receipt(session, principal, operation_id)
    if r is None:
        raise NotFound()
    return r


@router.get("/users")
async def users(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    from app.models import CampMembership, Membership

    if "access.manage" not in principal.permissions and "audit.read" not in principal.permissions:
        raise Forbidden()
    rows = (
        await session.execute(
            select(User, Membership).join(
                Membership, and_(Membership.user_id == User.id, Membership.org_id == principal.org_id)
            )
        )
    ).all()
    out = []
    for u, m in rows:
        cms = (await session.execute(select(CampMembership).where(CampMembership.user_id == u.id))).scalars()
        out.append(
            {
                "id": str(u.id),
                "display_name": u.display_name,
                "email": u.email,
                "role": m.role,
                "enabled": u.enabled and m.enabled,
                "camps": [
                    {"camp_id": str(c.camp_id), "enabled": c.enabled, "permissions": c.permissions}
                    for c in cms
                ],
            }
        )
    return {"items": out}
