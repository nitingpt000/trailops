"""Online console commands: equipment catalogue, forms, access (spec §8, §11, §17)."""

import re
import uuid

from pydantic import Field
from sqlalchemy import func, select

from app.core.errors import Conflict, Forbidden, InvalidInput, NotFound
from app.core.tx import bump
from app.models import (
    Camp,
    CampMembership,
    EquipmentCategory,
    EquipmentItem,
    FormDefinition,
    FormVersion,
    Membership,
)
from app.modules.commands.base import CommandCtx, Strict, aggregate, command, item_camp, location_in_org
from app.modules.forms.engine import canonical_json, schema_hash, validate_schema

TAG = re.compile(r"^[A-Z]{2,4}-\d{3,4}$")


class EquipmentCreate(Strict):
    category_id: uuid.UUID
    tag: str
    location_id: uuid.UUID
    size: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=1000)


@command("EQUIPMENT_CREATE", EquipmentCreate)
async def equipment_create(ctx: CommandCtx, p: EquipmentCreate) -> dict:
    tx = ctx.tx
    item_id = aggregate(ctx)
    loc = await location_in_org(ctx, p.location_id)
    ctx.principal.require("equipment.manage", loc.camp_id)
    tag = p.tag.strip().upper()
    if not TAG.fullmatch(tag):
        raise InvalidInput("INVALID_TAG", "Tags look like JKT-014.", field_errors={"tag": "format"})
    cat = await tx.session.get(EquipmentCategory, p.category_id)
    if cat is None or cat.org_id != tx.org_id:
        raise InvalidInput("UNKNOWN_CATEGORY", "Unknown category.", field_errors={"category_id": "unknown"})
    dup = (
        await tx.session.execute(
            select(EquipmentItem.id).where(EquipmentItem.org_id == tx.org_id, EquipmentItem.tag == tag)
        )
    ).first()
    if dup:
        raise InvalidInput("DUPLICATE_TAG", f"{tag} already exists.", field_errors={"tag": "duplicate"})
    if await tx.session.get(EquipmentItem, item_id) is not None:
        raise InvalidInput("ITEM_ID_TAKEN", "Item id already used.")
    item = EquipmentItem(
        id=item_id,
        org_id=tx.org_id,
        tag=tag,
        category_id=cat.id,
        size=p.size,
        status="READY",
        location_id=loc.id,
        notes=p.notes,
        version=1,
    )
    tx.session.add(item)
    await tx.session.flush()
    await tx.emit("equipment", item)
    await tx.audit(
        "equipment",
        item.id,
        "CREATED",
        after={"tag": tag, "category": cat.code},
        version=1,
        camp_id=loc.camp_id,
        summary=f"Added {tag} to inventory",
    )
    return {"item_id": str(item.id), "tag": tag}


class EquipmentUpdate(Strict):
    size: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=1000)
    category_id: uuid.UUID | None = None


@command("EQUIPMENT_UPDATE", EquipmentUpdate)
async def equipment_update(ctx: CommandCtx, p: EquipmentUpdate) -> dict:
    """Metadata only; status, location and allocation are never patchable (spec §11)."""
    tx = ctx.tx
    item = await tx.lock_one(EquipmentItem, aggregate(ctx), missing="UNKNOWN_ITEM")
    camp_id = await item_camp(ctx, item)
    ctx.principal.require("equipment.manage", camp_id)
    if ctx.op.expected_version is None:
        raise InvalidInput("EXPECTED_VERSION_REQUIRED", "Edits must state the version they were based on.")
    tx.check_version("equipment", item, ctx.op.expected_version)
    patch = p.model_dump(exclude_unset=True)
    before = {k: str(getattr(item, k)) if getattr(item, k) is not None else None for k in patch}
    if "category_id" in patch:
        cat = await tx.session.get(EquipmentCategory, p.category_id)
        if cat is None or cat.org_id != tx.org_id:
            raise InvalidInput("UNKNOWN_CATEGORY", "Unknown category.")
    for k, v in patch.items():
        setattr(item, k, v)
    bump(item)
    await tx.emit("equipment", item)
    await tx.audit(
        "equipment",
        item.id,
        "UPDATED",
        before=before,
        after={k: str(v) if v is not None else None for k, v in patch.items()},
        version=item.version,
        camp_id=camp_id,
    )
    return {"item_id": str(item.id), "version": item.version}


class FormDraftSave(Strict):
    schema_: dict = Field(alias="schema")


@command("FORM_DRAFT_SAVE", FormDraftSave)
async def form_draft_save(ctx: CommandCtx, p: FormDraftSave) -> dict:
    tx = ctx.tx
    if "forms.edit" not in ctx.principal.permissions:
        raise Forbidden()
    definition = await tx.lock_one(FormDefinition, aggregate(ctx), missing="UNKNOWN_FORM")
    if len(canonical_json(p.schema_)) > 64_000:
        raise InvalidInput("SCHEMA_TOO_LARGE", "Form definition is too large.")
    draft = (
        await tx.session.execute(
            select(FormVersion)
            .where(
                FormVersion.org_id == tx.org_id,
                FormVersion.definition_id == definition.id,
                FormVersion.status == "DRAFT",
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if draft is None:
        last = (
            await tx.session.execute(
                select(func.max(FormVersion.number)).where(
                    FormVersion.org_id == tx.org_id, FormVersion.definition_id == definition.id
                )
            )
        ).scalar() or 0
        draft = FormVersion(
            org_id=tx.org_id,
            definition_id=definition.id,
            number=last + 1,
            status="DRAFT",
            schema={},
            schema_hash="",
            version=0,
        )
        tx.session.add(draft)
    else:
        tx.check_version("form_version", draft, ctx.expected_for("form_version", draft.id))
    schema = dict(p.schema_)
    schema["key"] = definition.key
    schema["version"] = draft.number
    draft.schema = schema
    draft.schema_hash = schema_hash(schema)
    bump(draft)
    await tx.session.flush()
    await tx.audit(
        "form_version",
        draft.id,
        "DRAFT_SAVED",
        version=draft.version,
        summary=f"{definition.title} v{draft.number} draft saved",
    )
    return {
        "form_version_id": str(draft.id),
        "number": draft.number,
        "version": draft.version,
        "schema_hash": draft.schema_hash,
        "validation_errors": validate_schema(schema),
    }


class FormPublish(Strict):
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


@command("FORM_PUBLISH", FormPublish, online_only=True)
async def form_publish(ctx: CommandCtx, p: FormPublish) -> dict:
    tx = ctx.tx
    if "forms.publish" not in ctx.principal.permissions:
        raise Forbidden()
    fv = await tx.lock_one(FormVersion, aggregate(ctx), missing="UNKNOWN_FORM_VERSION")
    if fv.status != "DRAFT":
        raise Conflict("ALREADY_PUBLISHED", "Published versions are immutable.")
    if fv.schema_hash != p.expected_hash:
        raise Conflict("VERSION_CONFLICT", "The draft changed since you reviewed it.")
    errors = validate_schema(fv.schema)
    if errors:
        raise InvalidInput("INVALID_SCHEMA", "The form cannot be published.", field_errors=errors)
    definition = await tx.lock_one(FormDefinition, fv.definition_id)
    from datetime import UTC, datetime

    fv.status = "PUBLISHED"
    fv.published_at = datetime.now(UTC)
    fv.published_by = ctx.principal.user_id
    bump(fv)
    definition.active_version_id = fv.id
    bump(definition)
    await tx.emit("form_version", fv)
    await tx.emit("form_definition", definition)
    await tx.audit(
        "form_version",
        fv.id,
        "PUBLISHED",
        after={"number": fv.number, "hash": fv.schema_hash},
        version=fv.version,
        summary=f"{definition.title} v{fv.number} published",
    )
    return {"form_version_id": str(fv.id), "number": fv.number}


class MembershipUpdate(Strict):
    user_id: uuid.UUID
    camp_id: uuid.UUID
    enabled: bool
    permissions: list[str] = Field(default_factory=list, max_length=20)


@command("MEMBERSHIP_UPDATE", MembershipUpdate, requires_aggregate=False, online_only=True)
async def membership_update(ctx: CommandCtx, p: MembershipUpdate) -> dict:
    tx = ctx.tx
    if "access.manage" not in ctx.principal.permissions:
        raise Forbidden()
    camp = await tx.session.get(Camp, p.camp_id)
    if camp is None or camp.org_id != tx.org_id:
        raise NotFound()
    m = (
        await tx.session.execute(
            select(Membership)
            .where(Membership.org_id == tx.org_id, Membership.user_id == p.user_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if m is None:
        raise NotFound()
    # Optimistic check: scope_epoch is the membership's version (exposed by GET /v1/users).
    if ctx.op.expected_version is not None and ctx.op.expected_version != m.scope_epoch:
        raise Conflict("VERSION_CONFLICT", "This person's access changed since you loaded it. Refresh and review.")
    cm = (
        await tx.session.execute(
            select(CampMembership)
            .where(
                CampMembership.org_id == tx.org_id,
                CampMembership.user_id == p.user_id,
                CampMembership.camp_id == p.camp_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if cm is None:
        cm = CampMembership(org_id=tx.org_id, user_id=p.user_id, camp_id=p.camp_id, access_epoch=0)
        tx.session.add(cm)
    cm.enabled = p.enabled
    cm.permissions = p.permissions
    cm.access_epoch = (cm.access_epoch or 0) + 1
    m.scope_epoch += 1  # forces a scoped refresh on the user's devices (spec §18)
    await tx.session.flush()
    await tx.audit(
        "membership",
        m.id,
        "CAMP_ACCESS_CHANGED",
        after={"camp": camp.code, "enabled": p.enabled, "permissions": p.permissions},
        camp_id=camp.id,
        summary=f"Access to {camp.name} {'granted' if p.enabled else 'revoked'}",
    )
    return {"user_id": str(p.user_id), "camp_id": str(p.camp_id), "enabled": p.enabled}
