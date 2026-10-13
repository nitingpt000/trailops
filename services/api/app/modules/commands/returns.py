"""SUBMIT_RETURN, repair lifecycle, release and retirement (spec §14, §15)."""

import uuid
from datetime import UTC, datetime
from typing import Literal

from pydantic import Field
from sqlalchemy import select

from app.core.errors import Conflict, InvalidInput
from app.core.settings import get_settings
from app.core.tx import bump
from app.models import (
    Allocation,
    Attachment,
    EquipmentItem,
    FormDefinition,
    FormVersion,
    Inspection,
    Repair,
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
from app.modules.forms.engine import validate_answers

ALLOWED_MIME = {"image/jpeg", "image/png"}
OPEN_REPAIR_STATES = ("REQUESTED", "MORE_INFORMATION_REQUIRED", "APPROVED", "IN_PROGRESS", "AWAITING_RELEASE")


class AttachmentDescriptor(Strict):
    attachment_id: uuid.UUID
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime: str
    bytes: int = Field(gt=0)


class SubmitReturn(Strict):
    inspection_id: uuid.UUID
    allocation_id: uuid.UUID
    form_version_id: uuid.UUID
    answers: dict
    attachments: list[AttachmentDescriptor] = Field(default_factory=list, max_length=5)


async def load_published_form(ctx: CommandCtx, version_id: uuid.UUID, key: str) -> FormVersion:
    fv = await ctx.tx.session.get(FormVersion, version_id)
    if fv is None or fv.org_id != ctx.tx.org_id or fv.status == "DRAFT":
        raise InvalidInput("FORM_VERSION_UNKNOWN", "This form version is not published.")
    definition = await ctx.tx.session.get(FormDefinition, fv.definition_id)
    if definition is None or definition.key != key:
        raise InvalidInput("FORM_MISMATCH", "Wrong form for this workflow.")
    if fv.status == "RETIRED":
        raise InvalidInput(
            "FORM_VERSION_UNSUPPORTED",
            "This form version is no longer accepted. Your answers are kept for supervised migration.",
        )
    return fv


async def latest_inspection(ctx: CommandCtx, item_id: uuid.UUID, kinds: tuple[str, ...]) -> Inspection | None:
    return (
        await ctx.tx.session.execute(
            select(Inspection)
            .where(
                Inspection.org_id == ctx.tx.org_id, Inspection.item_id == item_id, Inspection.kind.in_(kinds)
            )
            .order_by(Inspection.submitted_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def open_repair(ctx: CommandCtx, item_id: uuid.UUID, *, lock: bool = True) -> Repair | None:
    q = select(Repair).where(
        Repair.org_id == ctx.tx.org_id, Repair.item_id == item_id, Repair.state.in_(OPEN_REPAIR_STATES)
    )
    if lock:
        q = q.with_for_update()
    return (await ctx.tx.session.execute(q)).scalar_one_or_none()


@command("SUBMIT_RETURN", SubmitReturn)
async def submit_return(ctx: CommandCtx, p: SubmitReturn) -> dict:
    tx = ctx.tx
    settings = get_settings()
    item_id = aggregate(ctx)
    locked = await tx.lock(EquipmentItem, [item_id], missing="UNKNOWN_ITEM")
    item = locked[item_id]
    camp_id = await item_camp(ctx, item)
    ctx.principal.require("return.submit", camp_id)
    alloc = (await tx.lock(Allocation, [p.allocation_id], missing="UNKNOWN_ALLOCATION"))[p.allocation_id]
    if alloc.item_id != item.id:
        raise InvalidInput("ALLOCATION_MISMATCH", "That allocation belongs to a different item.")
    if alloc.state != "ACTIVE":
        raise Conflict(
            "ALLOCATION_NOT_ACTIVE",
            "This allocation is already closed. Review the item's history.",
            details={"allocation_state": alloc.state},
        )
    tx.check_version("allocation", alloc, ctx.expected_for("allocation", alloc.id))
    if await tx.session.get(Inspection, p.inspection_id) is not None:
        raise InvalidInput("INSPECTION_ID_TAKEN", "Inspection id already used.")

    if len(p.attachments) > settings.max_photos_per_return:
        raise InvalidInput("TOO_MANY_PHOTOS", f"At most {settings.max_photos_per_return} photos per return.")
    for a in p.attachments:
        if a.mime not in ALLOWED_MIME:
            raise InvalidInput("UNSUPPORTED_MEDIA", "Photos must be JPEG or PNG.")
        if a.bytes > settings.max_photo_bytes:
            raise InvalidInput("PHOTO_TOO_LARGE", "Photo exceeds the size limit.")
        if await tx.session.get(Attachment, a.attachment_id) is not None:
            raise InvalidInput("ATTACHMENT_ID_TAKEN", "Attachment id already used.")

    fv = await load_published_form(ctx, p.form_version_id, "return-inspection")
    ids = {str(a.attachment_id) for a in p.attachments}
    errors = validate_answers(fv.schema, p.answers, attachment_ids=ids)
    if errors:
        raise InvalidInput("INVALID_ANSWERS", "The inspection answers are invalid.", field_errors=errors)
    condition = p.answers["condition"]
    photo_refs = {
        x for f in fv.schema["fields"] if f["type"] == "photo" for x in p.answers.get(f["id"], []) or []
    }
    if photo_refs != ids:
        raise InvalidInput(
            "ATTACHMENT_MISMATCH", "Every uploaded photo must be referenced by a photo answer."
        )
    # Proposed policy: every NEEDS_REPAIR inspection needs photographic evidence (spec §29).
    if condition == "NEEDS_REPAIR" and not p.attachments:
        raise InvalidInput(
            "EVIDENCE_REQUIRED", "Add at least one photo of the damage.", field_errors={"photos": "required"}
        )

    now = datetime.now(UTC)
    before = item_snapshot(item)
    insp = Inspection(
        id=p.inspection_id,
        org_id=tx.org_id,
        item_id=item.id,
        allocation_id=alloc.id,
        kind="RETURN",
        form_version_id=fv.id,
        answers=p.answers,
        condition=condition,
        issue_type=p.answers.get("issue_type"),
        notes=p.answers.get("notes"),
        evidence_state="PENDING" if p.attachments else "NOT_REQUIRED",
        submitted_by=ctx.principal.user_id,
        client_recorded_at=ctx.op.client_recorded_at,
        version=1,
    )
    tx.session.add(insp)
    await tx.session.flush()
    attachments = []
    for a in p.attachments:
        ext = "jpg" if a.mime == "image/jpeg" else "png"
        att = Attachment(
            id=a.attachment_id,
            org_id=tx.org_id,
            owner_user_id=ctx.principal.user_id,
            inspection_id=insp.id,
            content_hash=a.sha256,
            object_key=f"{tx.org_id}/inspections/{insp.id}/{a.attachment_id}.{ext}",
            mime=a.mime,
            bytes=a.bytes,
            state="PENDING",
            version=1,
        )
        tx.session.add(att)
        attachments.append(att)
    alloc.state = "RETURNED"
    alloc.closed_at = now
    bump(alloc)
    item.status = "QUARANTINED"
    item.last_inspected_at = now
    bump(item)
    repair = None
    if condition in ("NEEDS_REPAIR", "UNUSABLE"):
        repair = Repair(
            org_id=tx.org_id,
            item_id=item.id,
            inspection_id=insp.id,
            kind="REPAIR" if condition == "NEEDS_REPAIR" else "DISPOSITION",
            state="REQUESTED",
            requested_by=ctx.principal.user_id,
            version=1,
        )
        tx.session.add(repair)
        if condition == "NEEDS_REPAIR":
            item.status = "REPAIR_PENDING"
    await tx.session.flush()
    await tx.emit("inspection", insp)
    for att in attachments:
        await tx.emit("attachment", att)
    await tx.emit("allocation", alloc)
    await tx.emit("equipment", item)
    if repair:
        await tx.emit("repair", repair)
    await tx.audit(
        "equipment",
        item.id,
        "RETURNED",
        before=before,
        after=item_snapshot(item),
        version=item.version,
        camp_id=camp_id,
        summary=f"Returned {item.tag}: {condition}",
    )
    await tx.audit(
        "inspection",
        insp.id,
        "SUBMITTED",
        after={"condition": condition, "form_version": fv.number, "photos": len(attachments)},
        version=1,
        camp_id=camp_id,
    )
    if repair:
        await tx.audit(
            "repair", repair.id, "REQUESTED", after={"kind": repair.kind}, version=1, camp_id=camp_id
        )
    return {
        "inspection_id": str(insp.id),
        "repair_id": str(repair.id) if repair else None,
        "upload_required": [str(a.id) for a in attachments],
    }


class ApproveRepair(Strict):
    decision: Literal["APPROVE", "MORE_INFORMATION", "DENY"]
    note: str = Field(default="", max_length=1000)
    disposition: Literal["RETIRE", "QUARANTINE", "REPAIR"] | None = None


async def _repair_and_item(ctx: CommandCtx) -> tuple[Repair, EquipmentItem, uuid.UUID]:
    tx = ctx.tx
    repair = await tx.lock_one(Repair, aggregate(ctx), missing="UNKNOWN_REPAIR")
    item = await tx.lock_one(EquipmentItem, repair.item_id)
    camp_id = await item_camp(ctx, item)
    tx.check_version("repair", repair, ctx.expected_for("repair", repair.id))
    return repair, item, camp_id


@command("APPROVE_REPAIR", ApproveRepair, online_only=True)
async def approve_repair(ctx: CommandCtx, p: ApproveRepair) -> dict:
    tx = ctx.tx
    repair, item, camp_id = await _repair_and_item(ctx)
    ctx.principal.require("repair.approve", camp_id)
    if repair.state not in ("REQUESTED", "MORE_INFORMATION_REQUIRED"):
        raise Conflict("REPAIR_ALREADY_DECIDED", f"This request is already {repair.state.lower()}.")
    insp = await tx.session.get(Inspection, repair.inspection_id) if repair.inspection_id else None
    before = {"repair": repair.state, **item_snapshot(item)}
    if p.decision == "APPROVE":
        if insp is not None and insp.evidence_state not in ("VERIFIED", "NOT_REQUIRED"):
            raise Conflict(
                "EVIDENCE_PENDING",
                "Photos for this inspection have not been verified yet. Approval is blocked until they upload.",
                details={"evidence_state": insp.evidence_state},
            )
        if repair.kind == "DISPOSITION":
            # Approving a disposition request means approving retirement.
            repair.state = "CLOSED"
            item.status = "RETIRED"
        else:
            repair.state = "APPROVED"
            item.status = "UNDER_REPAIR"
    elif p.decision == "MORE_INFORMATION":
        if not p.note.strip():
            raise InvalidInput(
                "INVALID_INPUT", "Say what information is needed.", field_errors={"note": "required"}
            )
        repair.state = "MORE_INFORMATION_REQUIRED"
    else:
        # Denial never silently makes gear READY (spec §15).
        if p.disposition is None:
            raise InvalidInput(
                "DISPOSITION_REQUIRED",
                "Choose what happens to the item.",
                field_errors={"disposition": "required"},
            )
        if p.disposition == "REPAIR":
            if repair.kind != "DISPOSITION":
                raise InvalidInput("INVALID_INPUT", "Use APPROVE for repair requests.")
            repair.kind = "REPAIR"
            repair.state = "APPROVED"
            item.status = "UNDER_REPAIR"
        else:
            repair.state = "DENIED"
            item.status = "RETIRED" if p.disposition == "RETIRE" else "QUARANTINED"
    repair.approved_by = ctx.principal.user_id
    repair.decision_note = p.note or None
    bump(repair)
    bump(item)
    await tx.emit("repair", repair)
    await tx.emit("equipment", item)
    await tx.audit(
        "repair",
        repair.id,
        f"DECISION_{p.decision}",
        before=before,
        after={"repair": repair.state, **item_snapshot(item), "note": p.note},
        version=repair.version,
        camp_id=camp_id,
        summary=f"{p.decision.title()} repair for {item.tag}",
    )
    return {"repair_id": str(repair.id), "state": repair.state, "item_status": item.status}


class StartRepair(Strict):
    pass


class CompleteRepair(Strict):
    work_notes: str = Field(min_length=3, max_length=2000)


@command("START_REPAIR", StartRepair)
async def start_repair(ctx: CommandCtx, p: StartRepair) -> dict:
    repair, item, camp_id = await _repair_and_item(ctx)
    ctx.principal.require("repair.work", camp_id)
    if repair.state != "APPROVED":
        raise Conflict("REPAIR_NOT_APPROVED", "Only approved repairs can start.")
    repair.state = "IN_PROGRESS"
    repair.started_by = ctx.principal.user_id
    bump(repair)
    await ctx.tx.emit("repair", repair)
    await ctx.tx.audit("repair", repair.id, "STARTED", version=repair.version, camp_id=camp_id)
    return {"repair_id": str(repair.id), "state": repair.state}


@command("COMPLETE_REPAIR", CompleteRepair)
async def complete_repair(ctx: CommandCtx, p: CompleteRepair) -> dict:
    repair, item, camp_id = await _repair_and_item(ctx)
    ctx.principal.require("repair.work", camp_id)
    if repair.state != "IN_PROGRESS":
        raise Conflict("REPAIR_NOT_IN_PROGRESS", "Start the repair before completing it.")
    repair.state = "AWAITING_RELEASE"
    repair.completed_by = ctx.principal.user_id
    repair.work_notes = p.work_notes
    bump(repair)
    await ctx.tx.emit("repair", repair)
    await ctx.tx.audit(
        "repair",
        repair.id,
        "COMPLETED",
        after={"work_notes": p.work_notes},
        version=repair.version,
        camp_id=camp_id,
    )
    return {"repair_id": str(repair.id), "state": repair.state}


class ReleaseEquipment(Strict):
    inspection_id: uuid.UUID
    result: Literal["PASS", "FAIL"]
    notes: str = Field(default="", max_length=1000)


@command("RELEASE_EQUIPMENT", ReleaseEquipment)
async def release_equipment(ctx: CommandCtx, p: ReleaseEquipment) -> dict:
    tx = ctx.tx
    item = await tx.lock_one(EquipmentItem, aggregate(ctx), missing="UNKNOWN_ITEM")
    camp_id = await item_camp(ctx, item)
    ctx.principal.require("repair.release", camp_id)
    tx.check_version("equipment", item, ctx.expected_for("equipment", item.id))
    await require_no_custody_hold(ctx, item)
    if await tx.session.get(Inspection, p.inspection_id) is not None:
        raise InvalidInput("INSPECTION_ID_TAKEN", "Inspection id already used.")
    repair = await open_repair(ctx, item.id)
    match item.status:
        case "UNDER_REPAIR":
            if repair is None or repair.state != "AWAITING_RELEASE":
                raise Conflict("REPAIR_INCOMPLETE", "Repair work is not complete. It cannot be released yet.")
        case "REPAIR_PENDING":
            raise Conflict("REPAIR_NOT_APPROVED", "Repair has not been approved or completed.")
        case "QUARANTINED":
            if repair is not None:
                raise Conflict("DISPOSITION_PENDING", "A supervisor decision is still open for this item.")
            last = await latest_inspection(ctx, item.id, ("RETURN",))
            if last is not None and last.evidence_state not in ("VERIFIED", "NOT_REQUIRED"):
                raise Conflict("EVIDENCE_PENDING", "Inspection photos have not been verified yet.")
        case _:
            raise Conflict("ITEM_NOT_RELEASABLE", f"Items that are {item.status.lower()} cannot be released.")

    before = item_snapshot(item)
    insp = Inspection(
        id=p.inspection_id,
        org_id=tx.org_id,
        item_id=item.id,
        kind="RELEASE",
        answers={"result": p.result, "notes": p.notes},
        condition="GOOD" if p.result == "PASS" else "NEEDS_REPAIR",
        notes=p.notes or None,
        evidence_state="NOT_REQUIRED",
        submitted_by=ctx.principal.user_id,
        client_recorded_at=ctx.op.client_recorded_at,
        version=1,
    )
    tx.session.add(insp)
    await tx.session.flush()
    if p.result == "PASS":
        item.status = "READY"
        if repair is not None:
            repair.state = "CLOSED"
            repair.release_inspection_id = insp.id
    else:
        if repair is not None:
            repair.state = "IN_PROGRESS"  # back to the bench
        else:
            item.status = "QUARANTINED"
    item.last_inspected_at = datetime.now(UTC)
    bump(item)
    if repair is not None:
        bump(repair)
        await tx.emit("repair", repair)
    await tx.emit("inspection", insp)
    await tx.emit("equipment", item)
    await tx.audit(
        "equipment",
        item.id,
        "RELEASED" if p.result == "PASS" else "RELEASE_FAILED",
        before=before,
        after=item_snapshot(item),
        version=item.version,
        camp_id=camp_id,
        summary=f"Release inspection {p.result} for {item.tag}",
    )
    return {"item_id": str(item.id), "status": item.status, "inspection_id": str(insp.id)}


class RetireEquipment(Strict):
    reason: str = Field(min_length=3, max_length=500)


@command("RETIRE_EQUIPMENT", RetireEquipment)
async def retire_equipment(ctx: CommandCtx, p: RetireEquipment) -> dict:
    tx = ctx.tx
    item = await tx.lock_one(EquipmentItem, aggregate(ctx), missing="UNKNOWN_ITEM")
    camp_id = await item_camp(ctx, item)
    ctx.principal.require("equipment.retire", camp_id)
    tx.check_version("equipment", item, ctx.expected_for("equipment", item.id))
    if item.status in ("ISSUED", "IN_TRANSIT", "RETIRED"):
        raise Conflict("ITEM_NOT_RETIRABLE", f"Items that are {item.status.lower()} cannot be retired.")
    before = item_snapshot(item)
    repair = await open_repair(ctx, item.id)
    if repair is not None:
        repair.state = "CLOSED"
        repair.decision_note = p.reason
        bump(repair)
        await tx.emit("repair", repair)
    item.status = "RETIRED"
    bump(item)
    await tx.emit("equipment", item)
    await tx.audit(
        "equipment",
        item.id,
        "RETIRED",
        before=before,
        after=item_snapshot(item),
        version=item.version,
        camp_id=camp_id,
        summary=p.reason,
    )
    return {"item_id": str(item.id), "status": item.status}
