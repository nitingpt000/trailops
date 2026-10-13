"""Command envelope, registry and shared helpers (spec §8 command catalogue, §18)."""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.core.errors import Conflict, DomainError, InvalidInput
from app.core.tx import DomainTx
from app.models import CustodyClaim, EquipmentItem, Location


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Precondition(Strict):
    entity: Literal[
        "equipment", "allocation", "repair", "transfer", "transfer_line", "conflict", "form_version"
    ]
    id: uuid.UUID
    expected_version: int | None = None
    after_operation_id: uuid.UUID | None = None


class OperationIn(Strict):
    operation_id: uuid.UUID
    type: str = Field(max_length=60)
    aggregate_id: uuid.UUID | None = None
    expected_version: int | None = None
    depends_on: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    preconditions: list[Precondition] = Field(default_factory=list, max_length=120)
    client_recorded_at: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class DependencyPending(Exception):
    """Transient: a referenced operation or aggregate has not reached the server yet."""

    def __init__(self, message: str = "Waiting for an earlier operation to reach the server."):
        super().__init__(message)
        self.message = message


@dataclass
class CommandCtx:
    tx: DomainTx
    op: OperationIn
    # Resolved preconditions: "entity:id" -> expected version
    expected: dict[str, int]

    @property
    def principal(self):
        return self.tx.principal

    def expected_for(self, entity: str, id_: uuid.UUID) -> int | None:
        key = f"{entity}:{id_}"
        if key in self.expected:
            return self.expected[key]
        if self.op.aggregate_id == id_:
            return self.op.expected_version
        return None


Handler = Callable[[CommandCtx, Any], Awaitable[dict[str, Any]]]
ConflictHook = Callable[[CommandCtx, Any, DomainError], Awaitable[None]]


@dataclass
class CommandSpec:
    type: str
    payload_model: type[BaseModel]
    handler: Handler
    requires_aggregate: bool = True
    on_conflict: ConflictHook | None = None
    online_only: bool = False


REGISTRY: dict[str, CommandSpec] = {}


def command(
    type_: str,
    payload_model: type[BaseModel],
    *,
    requires_aggregate: bool = True,
    online_only: bool = False,
    on_conflict: ConflictHook | None = None,
):
    def deco(fn: Handler) -> Handler:
        REGISTRY[type_] = CommandSpec(type_, payload_model, fn, requires_aggregate, on_conflict, online_only)
        return fn

    return deco


def aggregate(ctx: CommandCtx) -> uuid.UUID:
    if ctx.op.aggregate_id is None:
        raise InvalidInput(
            "INVALID_INPUT", "aggregate_id is required.", field_errors={"aggregate_id": "required"}
        )
    return ctx.op.aggregate_id


async def location_in_org(ctx: CommandCtx, location_id: uuid.UUID) -> Location:
    loc = await ctx.tx.session.get(Location, location_id)
    if loc is None or loc.org_id != ctx.tx.org_id:
        raise InvalidInput(
            "UNKNOWN_LOCATION", "Location is not known.", field_errors={"location_id": "unknown"}
        )
    return loc


async def item_camp(ctx: CommandCtx, item: EquipmentItem) -> uuid.UUID:
    return await ctx.tx.proj.location_camp(item.location_id)


async def open_claims(ctx: CommandCtx, item_id: uuid.UUID) -> list[CustodyClaim]:
    return list(
        (
            await ctx.tx.session.execute(
                select(CustodyClaim).where(
                    CustodyClaim.org_id == ctx.tx.org_id,
                    CustodyClaim.item_id == item_id,
                    CustodyClaim.state == "OPEN",
                )
            )
        ).scalars()
    )


async def require_no_custody_hold(ctx: CommandCtx, item: EquipmentItem) -> None:
    claims = await open_claims(ctx, item.id)
    if claims:
        raise Conflict(
            "CUSTODY_HOLD",
            f"{item.tag} has an unresolved custody claim. A supervisor must reconcile it first.",
            details={"item_id": str(item.id), "claims": [str(c.id) for c in claims]},
        )


def item_snapshot(item: EquipmentItem) -> dict[str, Any]:
    return {"status": item.status, "location_id": str(item.location_id), "version": item.version}
