"""Tagged-asset handovers: dispatch, receipt, discrepancy resolution (spec §16)."""

import uuid
from datetime import UTC, datetime
from typing import Literal

from pydantic import Field
from sqlalchemy import select

from app.core.errors import Conflict, Forbidden, InvalidInput
from app.core.tx import bump
from app.models import CustodyClaim, EquipmentItem, Transfer, TransferLine
from app.modules.commands.base import (
    CommandCtx,
    DependencyPending,
    Strict,
    aggregate,
    command,
    item_snapshot,
    location_in_org,
    open_claims,
)


class DispatchTransfer(Strict):
    from_location_id: uuid.UUID
    to_location_id: uuid.UUID
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    note: str = Field(default="", max_length=500)


@command("DISPATCH_TRANSFER", DispatchTransfer)
async def dispatch_transfer(ctx: CommandCtx, p: DispatchTransfer) -> dict:
    tx = ctx.tx
    transfer_id = aggregate(ctx)
    if p.from_location_id == p.to_location_id:
        raise InvalidInput("SAME_LOCATION", "Origin and destination must differ.")
    if len(set(p.item_ids)) != len(p.item_ids):
        raise InvalidInput("DUPLICATE_ITEMS", "Each item can appear only once on a manifest.")
    origin = await location_in_org(ctx, p.from_location_id)
    await location_in_org(ctx, p.to_location_id)
    ctx.principal.require("transfer.dispatch", origin.camp_id)
    if await tx.session.get(Transfer, transfer_id) is not None:
        raise InvalidInput("TRANSFER_ID_TAKEN", "Transfer id already used.")
    items = await tx.lock(EquipmentItem, p.item_ids, missing="UNKNOWN_ITEM")
    problems = []
    for item in items.values():
        reason = None
        if item.location_id != p.from_location_id:
            reason = "not at origin"
        elif item.status != "READY":
            reason = item.status.lower()
        elif await open_claims(ctx, item.id):
            reason = "custody hold"
        else:
            expected = ctx.expected_for("equipment", item.id)
            if expected is not None and expected != item.version:
                reason = "changed since download"
        if reason:
            problems.append({"item_id": str(item.id), "tag": item.tag, "reason": reason})
    if problems:
        # All-or-nothing: no partial dispatch (spec §16, TR-01).
        raise Conflict(
            "TRANSFER_ITEM_UNAVAILABLE",
            "Some items cannot be dispatched: " + ", ".join(f"{x['tag']} ({x['reason']})" for x in problems),
            details={"items": problems},
        )
    transfer = Transfer(
        id=transfer_id,
        org_id=tx.org_id,
        code=f"HO-{str(transfer_id)[:6].upper()}",
        from_location_id=p.from_location_id,
        to_location_id=p.to_location_id,
        state="DISPATCHED",
        carrier_note=p.note or None,
        dispatched_by=ctx.principal.user_id,
        version=1,
    )
    tx.session.add(transfer)
    await tx.session.flush()
    lines = []
    for item_id in p.item_ids:
        line = TransferLine(org_id=tx.org_id, transfer_id=transfer.id, item_id=item_id, version=1)
        tx.session.add(line)
        lines.append(line)
        item = items[item_id]
        item.status = "IN_TRANSIT"
        bump(item)
    await tx.session.flush()
    await tx.emit("transfer", transfer)
    for line in lines:
        await tx.emit("transfer_line", line)
    for item_id in p.item_ids:
        await tx.emit("equipment", items[item_id])
    await tx.audit(
        "transfer",
        transfer.id,
        "DISPATCHED",
        after={"items": [items[i].tag for i in p.item_ids]},
        version=1,
        camp_id=origin.camp_id,
        summary=f"Dispatched {len(lines)} items ({transfer.code})",
    )
    return {"transfer_id": str(transfer.id), "code": transfer.code, "lines": len(lines)}


class ReceiptLine(Strict):
    item_id: uuid.UUID
    result: Literal["RECEIVED", "MISSING"]
    note: str = Field(default="", max_length=300)


class ExtraItem(Strict):
    tag: str = Field(max_length=40)
    note: str = Field(default="", max_length=300)


class ReceiveTransfer(Strict):
    lines: list[ReceiptLine] = Field(min_length=1, max_length=100)
    extra_items: list[ExtraItem] = Field(default_factory=list, max_length=20)
    notes: str = Field(default="", max_length=1000)


@command("RECEIVE_TRANSFER", ReceiveTransfer)
async def receive_transfer(ctx: CommandCtx, p: ReceiveTransfer) -> dict:
    tx = ctx.tx
    transfer_id = aggregate(ctx)
    existing = await tx.session.get(Transfer, transfer_id)
    if existing is None or existing.org_id != tx.org_id:
        # The receiver may act before the sender's dispatch has synced (TR-03).
        raise DependencyPending("The dispatch for this handover has not reached the server yet.")
    transfer = await tx.lock_one(Transfer, transfer_id)
    dest = await location_in_org(ctx, transfer.to_location_id)
    ctx.principal.require("transfer.receive", dest.camp_id)
    if transfer.state != "DISPATCHED":
        raise Conflict("TRANSFER_ALREADY_RECEIVED", "This handover was already received.")
    tx.check_version("transfer", transfer, ctx.expected_for("transfer", transfer.id))
    manifest = {
        line.item_id: line
        for line in (
            await tx.session.execute(
                select(TransferLine)
                .where(TransferLine.org_id == tx.org_id, TransferLine.transfer_id == transfer.id)
                .with_for_update()
            )
        ).scalars()
    }
    reported = [ln.item_id for ln in p.lines]
    if len(set(reported)) != len(reported) or set(reported) != set(manifest):
        raise InvalidInput("RECEIPT_MISMATCH", "Confirm every dispatched tag exactly once.")
    items = await tx.lock(EquipmentItem, list(manifest))
    now = datetime.now(UTC)
    missing = 0
    claims: list[CustodyClaim] = []
    for rl in p.lines:
        line = manifest[rl.item_id]
        item = items[rl.item_id]
        before = item_snapshot(item)
        if rl.result == "RECEIVED":
            line.receipt_state = "RECEIVED"
            item.location_id = transfer.to_location_id
            item.status = "QUARANTINED"  # until receipt inspection / release
        else:
            missing += 1
            line.receipt_state = "MISSING"
            line.discrepancy_reason = rl.note or "Not observed at destination"
            item.status = "MISSING"  # stays at origin location; never moved or made READY
            claim = CustodyClaim(
                org_id=tx.org_id,
                item_id=item.id,
                source_type="TRANSFER_MISSING",
                source_id=line.id,
                observed_location_id=None,
                description=f"{item.tag} was dispatched on {transfer.code} but not received.",
                state="OPEN",
                version=1,
            )
            tx.session.add(claim)
            claims.append(claim)
        bump(line)
        bump(item)
        await tx.audit(
            "equipment",
            item.id,
            f"HANDOVER_{rl.result}",
            before=before,
            after=item_snapshot(item),
            version=item.version,
            camp_id=dest.camp_id,
        )
    unknown_tags = []
    for extra in p.extra_items:
        found = (
            await tx.session.execute(
                select(EquipmentItem).where(
                    EquipmentItem.org_id == tx.org_id, EquipmentItem.tag == extra.tag.upper()
                )
            )
        ).scalar_one_or_none()
        if found is None:
            unknown_tags.append(extra.tag)
            continue
        claim = CustodyClaim(
            org_id=tx.org_id,
            item_id=found.id,
            source_type="TRANSFER_EXTRA",
            source_id=transfer.id,
            observed_location_id=transfer.to_location_id,
            description=f"{found.tag} arrived with {transfer.code} but was not on the manifest. {extra.note}".strip(),
            state="OPEN",
            version=1,
        )
        tx.session.add(claim)
        claims.append(claim)
    transfer.state = "DISCREPANCY" if (missing or p.extra_items) else "RECEIVED"
    transfer.received_by = ctx.principal.user_id
    transfer.received_at = now
    notes = p.notes
    if unknown_tags:
        notes = (notes + "\n" if notes else "") + "Unrecognised tags: " + ", ".join(unknown_tags)
    transfer.receipt_notes = notes or None
    bump(transfer)
    await tx.session.flush()
    await tx.emit("transfer", transfer)
    for line in manifest.values():
        await tx.emit("transfer_line", line)
    for item in items.values():
        await tx.emit("equipment", item)
    for claim in claims:
        await tx.emit("custody_claim", claim)
    await tx.audit(
        "transfer",
        transfer.id,
        "RECEIVED",
        after={"state": transfer.state, "missing": missing, "extra": len(p.extra_items)},
        version=transfer.version,
        camp_id=dest.camp_id,
        summary=f"Received {transfer.code}: {len(manifest) - missing}/{len(manifest)} items",
    )
    return {"transfer_id": str(transfer.id), "state": transfer.state, "missing": missing}


class ResolveDiscrepancy(Strict):
    finding: Literal["FOUND", "LOST"]
    location_id: uuid.UUID | None = None
    reason: str = Field(min_length=3, max_length=500)


@command("RESOLVE_TRANSFER_DISCREPANCY", ResolveDiscrepancy)
async def resolve_discrepancy(ctx: CommandCtx, p: ResolveDiscrepancy) -> dict:
    tx = ctx.tx
    line = await tx.lock_one(TransferLine, aggregate(ctx), missing="UNKNOWN_LINE")
    transfer = await tx.lock_one(Transfer, line.transfer_id)
    dest = await location_in_org(ctx, transfer.to_location_id)
    origin = await location_in_org(ctx, transfer.from_location_id)
    if not (
        ctx.principal.has("transfer.resolve", dest.camp_id)
        or ctx.principal.has("transfer.resolve", origin.camp_id)
    ):
        raise Forbidden()
    if line.receipt_state != "MISSING" or line.resolution is not None:
        raise Conflict("NO_OPEN_DISCREPANCY", "This line has no unresolved discrepancy.")
    item = await tx.lock_one(EquipmentItem, line.item_id)
    before = item_snapshot(item)
    if p.finding == "FOUND":
        # Requires an observed location and reason: no fabricated receipt (spec §16).
        if p.location_id is None:
            raise InvalidInput(
                "INVALID_INPUT", "Where was the item found?", field_errors={"location_id": "required"}
            )
        loc = await location_in_org(ctx, p.location_id)
        if not ctx.principal.can_access_camp(loc.camp_id):
            raise Forbidden()
        item.location_id = loc.id
        item.status = "QUARANTINED"
    else:
        item.status = "RETIRED"
    line.resolution = p.finding
    line.discrepancy_reason = f"{line.discrepancy_reason or ''} | Resolution: {p.reason}".strip(" |")
    bump(line)
    bump(item)
    claims = (
        (
            await tx.session.execute(
                select(CustodyClaim)
                .where(
                    CustodyClaim.org_id == tx.org_id,
                    CustodyClaim.source_type == "TRANSFER_MISSING",
                    CustodyClaim.source_id == line.id,
                    CustodyClaim.state == "OPEN",
                )
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    for claim in claims:
        claim.state = "RESOLVED"
        claim.resolution_note = p.reason
        bump(claim)
    remaining = (
        await tx.session.execute(
            select(TransferLine.id).where(
                TransferLine.org_id == tx.org_id,
                TransferLine.transfer_id == transfer.id,
                TransferLine.receipt_state == "MISSING",
                TransferLine.resolution.is_(None),
                TransferLine.id != line.id,
            )
        )
    ).first()
    if remaining is None:
        open_extra = (
            await tx.session.execute(
                select(CustodyClaim.id).where(
                    CustodyClaim.org_id == tx.org_id,
                    CustodyClaim.source_type == "TRANSFER_EXTRA",
                    CustodyClaim.source_id == transfer.id,
                    CustodyClaim.state == "OPEN",
                )
            )
        ).first()
        if open_extra is None:
            transfer.state = "RECONCILED"
            bump(transfer)
    await tx.session.flush()
    await tx.emit("transfer_line", line)
    await tx.emit("equipment", item)
    for claim in claims:
        await tx.emit("custody_claim", claim)
    await tx.emit("transfer", transfer)
    await tx.audit(
        "transfer_line",
        line.id,
        f"DISCREPANCY_{p.finding}",
        before=before,
        after=item_snapshot(item),
        version=line.version,
        camp_id=dest.camp_id,
        summary=p.reason,
    )
    return {"line_id": str(line.id), "item_status": item.status, "transfer_state": transfer.state}


class ResolveCustodyClaim(Strict):
    location_id: uuid.UUID | None = None
    note: str = Field(min_length=3, max_length=500)


@command("RESOLVE_CUSTODY_CLAIM", ResolveCustodyClaim)
async def resolve_custody_claim(ctx: CommandCtx, p: ResolveCustodyClaim) -> dict:
    """Supervisor reconciliation for extra/unexpected items after physical checks."""
    tx = ctx.tx
    claim = await tx.lock_one(CustodyClaim, aggregate(ctx), missing="UNKNOWN_CLAIM")
    item = await tx.lock_one(EquipmentItem, claim.item_id)
    camp_id = await tx.proj.location_camp(item.location_id)
    ctx.principal.require("transfer.resolve", camp_id)
    if claim.state != "OPEN":
        raise Conflict("CLAIM_ALREADY_RESOLVED", "Already resolved.")
    if claim.source_type == "ALLOCATION_CONFLICT":
        raise InvalidInput("USE_CONFLICT_RESOLUTION", "Resolve allocation conflicts from the conflict view.")
    if claim.source_type == "TRANSFER_MISSING":
        raise InvalidInput(
            "USE_DISCREPANCY_RESOLUTION", "Resolve missing items from the handover discrepancy."
        )
    before = item_snapshot(item)
    if p.location_id is not None:
        loc = await location_in_org(ctx, p.location_id)
        if not ctx.principal.can_access_camp(loc.camp_id):
            raise Forbidden()
        if item.status in ("ISSUED", "IN_TRANSIT"):
            raise Conflict("ITEM_BUSY", "Item is issued or in transit; it cannot be relocated.")
        item.location_id = loc.id
        if item.status in ("READY", "MISSING"):
            item.status = "QUARANTINED"
        bump(item)
        await tx.emit("equipment", item)
    claim.state = "RESOLVED"
    claim.resolution_note = p.note
    bump(claim)
    await tx.emit("custody_claim", claim)
    await tx.audit(
        "custody_claim",
        claim.id,
        "RESOLVED",
        before=before,
        after=item_snapshot(item),
        version=claim.version,
        camp_id=camp_id,
        summary=p.note,
    )
    return {"claim_id": str(claim.id)}
