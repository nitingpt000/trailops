"""ISSUE_GEAR and allocation-conflict resolution (spec §13, §19)."""

import uuid
from datetime import date, timedelta
from typing import Literal

from pydantic import Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import Conflict, DomainError, Forbidden, InvalidInput
from app.core.settings import get_settings
from app.core.tx import bump
from app.models import (
    Allocation,
    BatchMember,
    CustodyClaim,
    EquipmentItem,
    SyncConflict,
    TrekBatch,
    Trekker,
)
from app.modules.commands.base import (
    CommandCtx,
    Strict,
    aggregate,
    command,
    item_camp,
    item_snapshot,
    require_no_custody_hold,
)


class IssueGear(Strict):
    allocation_id: uuid.UUID
    trekker_id: uuid.UUID
    batch_id: uuid.UUID
    due_date: date
    observed_location_id: uuid.UUID | None = None
    resolves_conflict_id: uuid.UUID | None = None


async def _validate_recipient(ctx: CommandCtx, p: IssueGear, camp_id: uuid.UUID) -> tuple[TrekBatch, Trekker]:
    s = ctx.tx.session
    batch = await s.get(TrekBatch, p.batch_id)
    if batch is None or batch.org_id != ctx.tx.org_id or not ctx.principal.can_access_camp(batch.camp_id):
        raise InvalidInput(
            "UNKNOWN_BATCH", "Batch is not available to you.", field_errors={"batch_id": "unknown"}
        )
    if not batch.active:
        raise InvalidInput(
            "BATCH_INACTIVE", "This batch is no longer active.", field_errors={"batch_id": "inactive"}
        )
    if batch.camp_id != camp_id:
        raise InvalidInput(
            "BATCH_CAMP_MISMATCH",
            "Gear can only be issued to a batch at the item's camp.",
            field_errors={"batch_id": "different camp"},
        )
    member = (
        await s.execute(
            select(BatchMember).where(
                BatchMember.org_id == ctx.tx.org_id,
                BatchMember.batch_id == p.batch_id,
                BatchMember.trekker_id == p.trekker_id,
            )
        )
    ).scalar_one_or_none()
    trekker = await s.get(Trekker, p.trekker_id)
    if member is None or trekker is None or not trekker.active:
        raise InvalidInput(
            "NOT_BATCH_MEMBER",
            "This trekker is not on the batch roster.",
            field_errors={"trekker_id": "not a member"},
        )
    grace = timedelta(days=get_settings().due_date_grace_days)
    if p.due_date < batch.start_date or p.due_date > batch.end_date + grace:
        raise InvalidInput(
            "DUE_DATE_OUT_OF_POLICY",
            f"Due date must be between {batch.start_date} and {batch.end_date + grace}.",
            field_errors={"due_date": "out of policy"},
        )
    return batch, trekker


async def issue_item(ctx: CommandCtx, item_id: uuid.UUID, p: IssueGear) -> dict:
    tx = ctx.tx
    item = await tx.lock_one(EquipmentItem, item_id, missing="UNKNOWN_ITEM")
    camp_id = await item_camp(ctx, item)
    ctx.principal.require("issue.create", camp_id)
    batch, trekker = await _validate_recipient(ctx, p, camp_id)
    existing = await tx.session.get(Allocation, p.allocation_id)
    if existing is not None:
        raise InvalidInput("ALLOCATION_ID_TAKEN", "Allocation id is already in use.")
    if item.status != "READY":
        active = (
            await tx.session.execute(
                select(Allocation).where(
                    Allocation.org_id == tx.org_id,
                    Allocation.item_id == item.id,
                    Allocation.state == "ACTIVE",
                )
            )
        ).scalar_one_or_none()
        if active is not None:
            raise Conflict(
                "ITEM_ALREADY_ALLOCATED",
                "This item has a confirmed allocation. Choose replacement gear.",
                details={"item_id": str(item.id), "confirmed_allocation_id": str(active.id)},
            )
        raise Conflict(
            "ITEM_NOT_AVAILABLE",
            f"{item.tag} is {item.status.replace('_', ' ').lower()} and cannot be issued.",
            details={"item_id": str(item.id), "status": item.status},
        )
    tx.check_version("equipment", item, ctx.expected_for("equipment", item.id))
    await require_no_custody_hold(ctx, item)

    before = item_snapshot(item)
    alloc = Allocation(
        id=p.allocation_id,
        org_id=tx.org_id,
        item_id=item.id,
        trekker_id=trekker.id,
        batch_id=batch.id,
        issued_by=ctx.principal.user_id,
        client_recorded_at=ctx.op.client_recorded_at,
        due_date=p.due_date,
        state="ACTIVE",
        operation_id=ctx.op.operation_id,
        version=1,
    )
    tx.session.add(alloc)
    item.status = "ISSUED"
    bump(item)
    try:
        await tx.session.flush()
    except IntegrityError as exc:  # the partial unique index is the final guard
        raise Conflict("ITEM_ALREADY_ALLOCATED", "This item has a confirmed allocation.") from exc
    await tx.emit("equipment", item)
    await tx.emit("allocation", alloc)
    await tx.audit(
        "equipment",
        item.id,
        "ISSUED",
        before=before,
        after=item_snapshot(item),
        version=item.version,
        camp_id=camp_id,
        summary=f"Issued {item.tag} to {trekker.display_name} ({batch.code})",
    )
    await tx.audit(
        "allocation",
        alloc.id,
        "CREATED",
        after={"trekker_id": str(trekker.id), "batch": batch.code, "due_date": p.due_date.isoformat()},
        version=1,
        camp_id=camp_id,
    )
    return {"allocation_id": str(alloc.id), "item_id": str(item.id)}


async def record_issue_conflict(ctx: CommandCtx, p: IssueGear, err: DomainError) -> None:
    """Preserve the rejected local claim and flag physical reconciliation (spec §19)."""
    if err.code not in ("ITEM_ALREADY_ALLOCATED", "ITEM_NOT_AVAILABLE", "VERSION_CONFLICT", "CUSTODY_HOLD"):
        return
    tx = ctx.tx
    item = await tx.session.get(EquipmentItem, ctx.op.aggregate_id)
    if item is None or item.org_id != tx.org_id:
        return
    camp_id = await item_camp(ctx, item)
    trekker = await tx.session.get(Trekker, p.trekker_id)
    batch = await tx.session.get(TrekBatch, p.batch_id)
    details: dict = {
        "item_tag": item.tag,
        "item_status": item.status,
        "proposed": {
            "allocation_id": str(p.allocation_id),
            "trekker_id": str(p.trekker_id),
            "trekker_name": trekker.display_name if trekker and trekker.org_id == tx.org_id else None,
            "batch_id": str(p.batch_id),
            "batch_code": batch.code if batch and batch.org_id == tx.org_id else None,
            "due_date": p.due_date.isoformat(),
            "observed_at": ctx.op.client_recorded_at.isoformat() if ctx.op.client_recorded_at else None,
            "issued_by": str(ctx.principal.user_id),
            "issued_by_name": ctx.principal.display_name,
        },
        "message": err.message,
    }
    confirmed_id = err.details.get("confirmed_allocation_id")
    if confirmed_id:
        confirmed = await tx.session.get(Allocation, uuid.UUID(confirmed_id))
        if confirmed:
            cb = await tx.session.get(TrekBatch, confirmed.batch_id)
            ct = await tx.session.get(Trekker, confirmed.trekker_id)
            visible = cb is not None and ctx.principal.can_access_camp(cb.camp_id)
            details["confirmed"] = {
                "allocation_id": str(confirmed.id),
                "issued_at": confirmed.issued_at.isoformat(),
                # Recipient details only if the batch is in the viewer's scope.
                "trekker_name": ct.display_name if (visible and ct) else None,
                "batch_code": cb.code if visible and cb else None,
            }
    conflict = SyncConflict(
        org_id=tx.org_id,
        operation_id=ctx.op.operation_id,
        item_id=item.id,
        camp_id=camp_id,
        code=err.code,
        raised_by=ctx.principal.user_id,
        details=details,
        state="OPEN",
        version=1,
    )
    tx.session.add(conflict)
    await tx.session.flush()
    claim = CustodyClaim(
        org_id=tx.org_id,
        item_id=item.id,
        source_type="ALLOCATION_CONFLICT",
        source_id=conflict.id,
        observed_location_id=p.observed_location_id,
        description=f"Local issue of {item.tag} to {details['proposed']['trekker_name'] or 'a trekker'} "
        "was not accepted centrally; physical custody needs reconciliation.",
        state="OPEN",
        version=1,
    )
    tx.session.add(claim)
    await tx.session.flush()
    await tx.emit("conflict", conflict)
    await tx.emit("custody_claim", claim)
    await tx.audit(
        "conflict",
        conflict.id,
        "RAISED",
        after={"code": err.code, "item": item.tag},
        camp_id=camp_id,
        summary=f"Allocation conflict on {item.tag}",
    )


@command("ISSUE_GEAR", IssueGear, on_conflict=record_issue_conflict)
async def issue_gear(ctx: CommandCtx, p: IssueGear) -> dict:
    return await issue_item(ctx, aggregate(ctx), p)


class Replacement(Strict):
    item_id: uuid.UUID
    allocation_id: uuid.UUID
    due_date: date
    expected_version: int | None = None


class ResolveAllocationConflict(Strict):
    resolution: Literal["CANCEL_LOCAL_CLAIM", "REPLACE", "REASSIGN"]
    note: str = Field(min_length=3, max_length=500)
    replacement: Replacement | None = None
    reassign_allocation_id: uuid.UUID | None = None


async def _close_conflict(ctx: CommandCtx, conflict: SyncConflict, resolution: str) -> None:
    tx = ctx.tx
    conflict.state = "RESOLVED"
    conflict.resolution = resolution
    conflict.resolution_operation_id = ctx.op.operation_id
    bump(conflict)
    claims = (
        await tx.session.execute(
            select(CustodyClaim)
            .where(
                CustodyClaim.org_id == tx.org_id,
                CustodyClaim.source_type == "ALLOCATION_CONFLICT",
                CustodyClaim.source_id == conflict.id,
                CustodyClaim.state == "OPEN",
            )
            .with_for_update()
        )
    ).scalars()
    for claim in claims:
        claim.state = "RESOLVED"
        claim.resolution_note = resolution
        bump(claim)
        await tx.emit("custody_claim", claim)
    await tx.emit("conflict", conflict)


@command("RESOLVE_ALLOCATION_CONFLICT", ResolveAllocationConflict)
async def resolve_allocation_conflict(ctx: CommandCtx, p: ResolveAllocationConflict) -> dict:
    tx = ctx.tx
    conflict = await tx.lock_one(SyncConflict, aggregate(ctx), missing="UNKNOWN_CONFLICT")
    if not ctx.principal.can_access_camp(conflict.camp_id):
        raise Forbidden()
    if conflict.state != "OPEN":
        raise Conflict("CONFLICT_ALREADY_RESOLVED", "This conflict has already been resolved.")
    tx.check_version("conflict", conflict, ctx.expected_for("conflict", conflict.id))
    proposed = conflict.details.get("proposed", {})
    result: dict = {"conflict_id": str(conflict.id), "resolution": p.resolution}

    if p.resolution in ("CANCEL_LOCAL_CLAIM", "REPLACE"):
        if not (
            ctx.principal.has("conflict.resolve_local", conflict.camp_id)
            or ctx.principal.has("conflict.resolve", conflict.camp_id)
        ):
            raise Forbidden()
    else:
        ctx.principal.require("conflict.resolve", conflict.camp_id)

    if p.resolution == "REPLACE":
        if p.replacement is None:
            raise InvalidInput(
                "INVALID_INPUT", "Choose replacement gear.", field_errors={"replacement": "required"}
            )
        issue = IssueGear(
            allocation_id=p.replacement.allocation_id,
            trekker_id=uuid.UUID(proposed["trekker_id"]),
            batch_id=uuid.UUID(proposed["batch_id"]),
            due_date=p.replacement.due_date,
            resolves_conflict_id=conflict.id,
        )
        ctx.expected[f"equipment:{p.replacement.item_id}"] = p.replacement.expected_version  # type: ignore[assignment]
        if p.replacement.expected_version is None:
            ctx.expected.pop(f"equipment:{p.replacement.item_id}")
        # If the replacement is not available this raises and the whole resolution rolls back:
        # the conflict stays open (spec §19).
        result["replacement"] = await issue_item(ctx, p.replacement.item_id, issue)
    elif p.resolution == "REASSIGN":
        # Supervisor checked custody: reverse the confirmed allocation and allocate to the local recipient.
        item = await tx.lock_one(EquipmentItem, conflict.item_id)
        active = (
            await tx.session.execute(
                select(Allocation)
                .where(
                    Allocation.org_id == tx.org_id,
                    Allocation.item_id == item.id,
                    Allocation.state == "ACTIVE",
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if active is None:
            raise Conflict(
                "NO_CONFIRMED_ALLOCATION", "The item no longer has a confirmed allocation to reassign."
            )
        if p.reassign_allocation_id is None:
            raise InvalidInput("INVALID_INPUT", "A new allocation id is required.")
        active.state = "REVERSED"
        from datetime import UTC, datetime

        active.closed_at = datetime.now(UTC)
        bump(active)
        await tx.emit("allocation", active)
        await tx.audit(
            "allocation",
            active.id,
            "REVERSED",
            before={"state": "ACTIVE"},
            after={"state": "REVERSED"},
            version=active.version,
            camp_id=conflict.camp_id,
            summary=p.note,
        )
        new = Allocation(
            id=p.reassign_allocation_id,
            org_id=tx.org_id,
            item_id=item.id,
            trekker_id=uuid.UUID(proposed["trekker_id"]),
            batch_id=uuid.UUID(proposed["batch_id"]),
            issued_by=ctx.principal.user_id,
            due_date=date.fromisoformat(proposed["due_date"]),
            state="ACTIVE",
            operation_id=ctx.op.operation_id,
            version=1,
        )
        tx.session.add(new)
        await tx.session.flush()
        bump(item)
        await tx.emit("allocation", new)
        await tx.emit("equipment", item)
        await tx.audit(
            "allocation",
            new.id,
            "CREATED",
            after={"reassigned_from": str(active.id)},
            version=1,
            camp_id=conflict.camp_id,
        )
        result["allocation_id"] = str(new.id)

    await _close_conflict(ctx, conflict, p.resolution)
    await tx.audit(
        "conflict",
        conflict.id,
        "RESOLVED",
        after={"resolution": p.resolution, "note": p.note},
        version=conflict.version,
        camp_id=conflict.camp_id,
    )
    return result
