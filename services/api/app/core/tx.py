"""Domain write transaction (spec §6 'Each domain write transaction').

Order: lock the organization sequence row → lock aggregates in sorted UUID order → validate →
mutate → append audit + change events → persist operation receipt → bump sequence → commit.
Every domain writer (sync commands, console actions, workers) goes through this class, so change
numbers are allocated while the gate is held and commit in order.
"""

import uuid
from datetime import datetime
from typing import Any, TypeVar

from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal
from app.core.errors import Conflict, NotFound
from app.core.projections import ProjectionContext
from app.models import AuditEvent, ChangeLog, EntityScope, SyncSequence

T = TypeVar("T")


class DomainTx:
    def __init__(
        self,
        session: AsyncSession,
        principal: Principal,
        *,
        operation_id: uuid.UUID | None = None,
        command_type: str | None = None,
        client_recorded_at: datetime | None = None,
    ):
        self.session = session
        self.principal = principal
        self.org_id = principal.org_id
        self.operation_id = operation_id
        self.command_type = command_type
        self.client_recorded_at = client_recorded_at
        self.proj = ProjectionContext(session)
        self.sequence: int | None = None
        self._start_sequence: int | None = None
        self.versions: dict[str, int] = {}
        self.entities: list[dict[str, Any]] = []

    async def lock_gate(self) -> None:
        await self.session.execute(
            pg_insert(SyncSequence).values(org_id=self.org_id, last_sequence=0).on_conflict_do_nothing()
        )
        row = (
            await self.session.execute(
                select(SyncSequence).where(SyncSequence.org_id == self.org_id).with_for_update()
            )
        ).scalar_one()
        self.sequence = row.last_sequence
        self._start_sequence = row.last_sequence

    async def lock(
        self, model: type[T], ids: list[uuid.UUID], *, missing: str = "NOT_FOUND"
    ) -> dict[uuid.UUID, T]:
        """Lock rows in sorted UUID order (deterministic, avoids deadlocks). Org-scoped."""
        unique = sorted(set(ids), key=lambda u: u.bytes)
        if not unique:
            return {}
        rows = (
            await self.session.execute(
                select(model)
                .where(model.org_id == self.org_id, model.id.in_(unique))  # type: ignore[attr-defined]
                .order_by(model.id)  # type: ignore[attr-defined]
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalars()
        found = {r.id: r for r in rows}  # type: ignore[attr-defined]
        if len(found) != len(unique):
            raise NotFound(code=missing)
        return found

    async def lock_one(self, model: type[T], id_: uuid.UUID, *, missing: str = "NOT_FOUND") -> T:
        return (await self.lock(model, [id_], missing=missing))[id_]

    @staticmethod
    def check_version(entity: str, obj: Any, expected: int | None) -> None:
        if expected is not None and obj.version != expected:
            raise Conflict(
                "VERSION_CONFLICT",
                f"This {entity} changed since it was downloaded. Refresh and review.",
                details={"entity": entity, "id": str(obj.id), "expected": expected, "actual": obj.version},
            )

    async def emit(self, entity_type: str, obj: Any, *, deleted: bool = False) -> None:
        """Append a change-log event with before/after scopes and the full projection."""
        assert self.sequence is not None, "lock_gate() must run first"
        await self.session.flush()
        expired = sa_inspect(obj).expired_attributes
        if expired and not deleted:
            # Server-generated columns (updated_at, created_at) must be loaded before serializing.
            await self.session.refresh(obj, attribute_names=list(expired))
        after = [] if deleted else await self.proj.scope(entity_type, obj)
        prev = await self.session.get(EntityScope, (self.org_id, entity_type, obj.id))
        before = list(prev.scope) if prev else []
        payload = None if deleted else await self.proj.serialize(entity_type, obj)
        self.sequence += 1
        self.session.add(
            ChangeLog(
                org_id=self.org_id,
                sequence=self.sequence,
                entity_type=entity_type,
                entity_id=obj.id,
                version=getattr(obj, "version", 1) or 1,
                before_scope=before,
                after_scope=after,
                deleted=deleted,
                payload=payload,
            )
        )
        if prev is None:
            self.session.add(
                EntityScope(org_id=self.org_id, entity_type=entity_type, entity_id=obj.id, scope=after)
            )
        else:
            prev.scope = after
        version = getattr(obj, "version", None)
        if version is not None:
            self.versions[f"{entity_type}:{obj.id}"] = version
        if payload is not None:
            self.entities.append(
                {"entity": entity_type, "id": str(obj.id), "version": version, "data": payload}
            )

    async def audit(
        self,
        aggregate_type: str,
        aggregate_id: uuid.UUID,
        event_type: str,
        *,
        before: dict | None = None,
        after: dict | None = None,
        version: int | None = None,
        camp_id: uuid.UUID | None = None,
        summary: str | None = None,
    ) -> None:
        self.session.add(
            AuditEvent(
                org_id=self.org_id,
                camp_id=camp_id,
                aggregate_type=aggregate_type,
                aggregate_id=aggregate_id,
                aggregate_version=version,
                actor_id=self.principal.user_id,
                operation_id=self.operation_id,
                command_type=self.command_type,
                request_id=self.principal.request_id,
                event_type=event_type,
                summary=summary,
                before=before,
                after=after,
                client_recorded_at=self.client_recorded_at,
            )
        )

    async def finish(self) -> None:
        if self.sequence is not None and self.sequence != self._start_sequence:
            row = await self.session.get(SyncSequence, self.org_id)
            row.last_sequence = self.sequence
        await self.session.flush()


def bump(obj: Any) -> None:
    obj.version = (obj.version or 0) + 1
