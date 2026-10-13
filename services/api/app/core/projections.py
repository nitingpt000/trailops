"""Documented sync projections and their visibility scopes (spec §7, §18).

Every synced entity type has a serializer (the complete projection sent to clients) and a scope
function returning the camps allowed to see it, or ["*"] for organization-wide reference data.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Allocation,
    Attachment,
    BatchMember,
    Camp,
    CustodyClaim,
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
)

ORG_WIDE = "*"

# entity type name used on the wire → ORM class
ENTITY_TYPES: dict[str, type] = {
    "camp": Camp,
    "location": Location,
    "category": EquipmentCategory,
    "equipment": EquipmentItem,
    "batch": TrekBatch,
    "batch_member": BatchMember,
    "allocation": Allocation,
    "inspection": Inspection,
    "repair": Repair,
    "transfer": Transfer,
    "transfer_line": TransferLine,
    "custody_claim": CustodyClaim,
    "conflict": SyncConflict,
    "form_definition": FormDefinition,
    "form_version": FormVersion,
    "attachment": Attachment,
}


def _val(v: Any) -> Any:
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def _pick(obj: Any, fields: list[str]) -> dict[str, Any]:
    return {f: _val(getattr(obj, f)) for f in fields}


class ProjectionContext:
    """Per-transaction lookup cache for scope computation."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self._loc_camp: dict[uuid.UUID, uuid.UUID] = {}
        self._batch_camp: dict[uuid.UUID, uuid.UUID] = {}

    async def location_camp(self, location_id: uuid.UUID) -> uuid.UUID:
        if location_id not in self._loc_camp:
            loc = await self.session.get(Location, location_id)
            assert loc is not None
            self._loc_camp[location_id] = loc.camp_id
        return self._loc_camp[location_id]

    async def batch_camp(self, batch_id: uuid.UUID) -> uuid.UUID:
        if batch_id not in self._batch_camp:
            b = await self.session.get(TrekBatch, batch_id)
            assert b is not None
            self._batch_camp[batch_id] = b.camp_id
        return self._batch_camp[batch_id]

    async def item_camps(self, item: EquipmentItem) -> list[str]:
        camps = {str(await self.location_camp(item.location_id))}
        if item.status == "IN_TRANSIT":
            # Authorized in-transit references: the destination camp can see what is coming.
            row = (
                await self.session.execute(
                    select(Transfer.to_location_id)
                    .join(TransferLine, TransferLine.transfer_id == Transfer.id)
                    .where(
                        TransferLine.item_id == item.id,
                        TransferLine.org_id == item.org_id,
                        Transfer.state == "DISPATCHED",
                    )
                )
            ).first()
            if row:
                camps.add(str(await self.location_camp(row[0])))
        return sorted(camps)

    async def item_camps_by_id(self, item_id: uuid.UUID) -> list[str]:
        item = await self.session.get(EquipmentItem, item_id)
        assert item is not None
        return await self.item_camps(item)

    async def transfer_camps(self, transfer: Transfer) -> list[str]:
        return sorted(
            {
                str(await self.location_camp(transfer.from_location_id)),
                str(await self.location_camp(transfer.to_location_id)),
            }
        )

    async def scope(self, entity_type: str, obj: Any) -> list[str]:
        match entity_type:
            case "category" | "form_definition":
                return [ORG_WIDE]
            case "form_version":
                # Drafts are console-only; devices receive published, immutable versions.
                return [ORG_WIDE] if obj.status != "DRAFT" else []
            case "camp":
                return [str(obj.id)]
            case "location":
                return [str(obj.camp_id)]
            case "equipment":
                return await self.item_camps(obj)
            case "batch":
                return [str(obj.camp_id)]
            case "batch_member":
                return [str(await self.batch_camp(obj.batch_id))]
            case "allocation":
                return sorted(
                    {str(await self.batch_camp(obj.batch_id)), *await self.item_camps_by_id(obj.item_id)}
                )
            case "inspection" | "repair" | "custody_claim":
                return await self.item_camps_by_id(obj.item_id)
            case "transfer":
                return await self.transfer_camps(obj)
            case "transfer_line":
                tr = await self.session.get(Transfer, obj.transfer_id)
                return await self.transfer_camps(tr)
            case "conflict":
                return [str(obj.camp_id)]
            case "attachment":
                insp = await self.session.get(Inspection, obj.inspection_id)
                return await self.item_camps_by_id(insp.item_id)
        raise ValueError(entity_type)

    async def serialize(self, entity_type: str, obj: Any) -> dict[str, Any]:
        match entity_type:
            case "camp":
                return _pick(obj, ["id", "code", "name", "timezone", "active", "version"])
            case "location":
                return _pick(obj, ["id", "camp_id", "label", "type", "version"])
            case "category":
                return _pick(
                    obj, ["id", "code", "name", "group", "unit", "inspect_on_return", "image_key", "version"]
                )
            case "equipment":
                d = _pick(
                    obj,
                    [
                        "id",
                        "tag",
                        "category_id",
                        "size",
                        "status",
                        "location_id",
                        "notes",
                        "last_inspected_at",
                        "version",
                        "updated_at",
                    ],
                )
                d["camp_id"] = str(await self.location_camp(obj.location_id))
                d["retired"] = obj.status == "RETIRED"
                return d
            case "batch":
                return _pick(
                    obj, ["id", "code", "trek_name", "camp_id", "start_date", "end_date", "active", "version"]
                )
            case "batch_member":
                t = await self.session.get(Trekker, obj.trekker_id)
                d = _pick(obj, ["id", "batch_id", "trekker_id", "gear_requested"])
                d["display_name"] = t.display_name if t else None
                d["size_hint"] = t.size_hint if t else None
                d["active"] = bool(t and t.active)
                return d
            case "allocation":
                return _pick(
                    obj,
                    [
                        "id",
                        "item_id",
                        "trekker_id",
                        "batch_id",
                        "issued_by",
                        "issued_at",
                        "due_date",
                        "state",
                        "closed_at",
                        "version",
                    ],
                )
            case "inspection":
                return _pick(
                    obj,
                    [
                        "id",
                        "item_id",
                        "allocation_id",
                        "kind",
                        "form_version_id",
                        "answers",
                        "condition",
                        "issue_type",
                        "notes",
                        "evidence_state",
                        "submitted_by",
                        "submitted_at",
                        "version",
                    ],
                )
            case "repair":
                return _pick(
                    obj,
                    [
                        "id",
                        "item_id",
                        "inspection_id",
                        "kind",
                        "state",
                        "requested_by",
                        "approved_by",
                        "decision_note",
                        "work_notes",
                        "created_at",
                        "updated_at",
                        "version",
                    ],
                )
            case "transfer":
                return _pick(
                    obj,
                    [
                        "id",
                        "code",
                        "from_location_id",
                        "to_location_id",
                        "state",
                        "carrier_note",
                        "dispatched_by",
                        "dispatched_at",
                        "received_by",
                        "received_at",
                        "receipt_notes",
                        "version",
                    ],
                )
            case "transfer_line":
                return _pick(
                    obj,
                    [
                        "id",
                        "transfer_id",
                        "item_id",
                        "receipt_state",
                        "discrepancy_reason",
                        "resolution",
                        "version",
                    ],
                )
            case "custody_claim":
                return _pick(
                    obj,
                    [
                        "id",
                        "item_id",
                        "source_type",
                        "source_id",
                        "observed_location_id",
                        "description",
                        "state",
                        "created_at",
                        "version",
                    ],
                )
            case "conflict":
                return _pick(
                    obj,
                    [
                        "id",
                        "operation_id",
                        "item_id",
                        "camp_id",
                        "code",
                        "raised_by",
                        "details",
                        "state",
                        "resolution",
                        "resolution_operation_id",
                        "created_at",
                        "version",
                    ],
                )
            case "form_definition":
                return _pick(obj, ["id", "key", "title", "active_version_id", "version"])
            case "form_version":
                return _pick(
                    obj,
                    [
                        "id",
                        "definition_id",
                        "number",
                        "status",
                        "schema",
                        "schema_hash",
                        "published_at",
                        "version",
                    ],
                )
            case "attachment":
                return _pick(
                    obj, ["id", "inspection_id", "mime", "bytes", "state", "rejection_reason", "version"]
                )
        raise ValueError(entity_type)


def visible(scope: list[str], principal_scopes: set[str], org_wide: bool) -> bool:
    if not scope:
        return False
    if ORG_WIDE in scope or org_wide:
        return True
    return bool(principal_scopes.intersection(scope))
