"""Idempotent command processor (spec §18 'Server command transaction').

authenticate → org mutation gate → receipt lookup → replay or validate permissions → dependencies →
lock aggregates → check versions/invariants → mutate → audit/change records → persist receipt → commit.

Terminal business outcomes (ACCEPTED / REJECTED / CONFLICT) are persisted as receipts so a retry with
the same operation id returns the original result. Transient failures roll back and stay retryable.
"""

import hashlib
import logging
import uuid
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal
from app.core.errors import Conflict, DomainError, Forbidden
from app.core.tx import DomainTx
from app.models import Operation
from app.modules.commands import admin, issues, returns, transfers  # noqa: F401 (registers handlers)
from app.modules.commands.base import REGISTRY, CommandCtx, DependencyPending, OperationIn
from app.modules.forms.engine import canonical_json

log = logging.getLogger("trailops.commands")


def payload_hash(op: OperationIn, device_id: uuid.UUID | None) -> str:
    """Hash of immutable command fields; retry timing and tokens are excluded (spec §18)."""
    body = {
        "type": op.type,
        "aggregate_id": str(op.aggregate_id) if op.aggregate_id else None,
        "expected_version": op.expected_version,
        "depends_on": [str(d) for d in op.depends_on],
        "preconditions": [pc.model_dump(mode="json") for pc in op.preconditions],
        "payload": op.payload,
        "device_id": str(device_id) if device_id else None,
    }
    return hashlib.sha256(canonical_json(body).encode()).hexdigest()


def _receipt(
    op_id: uuid.UUID,
    status: str,
    *,
    code: str | None = None,
    message: str | None = None,
    retryable: bool = False,
    **extra: Any,
) -> dict[str, Any]:
    r = {
        "operation_id": str(op_id),
        "status": status,
        "code": code,
        "message": message,
        "retryable": retryable,
    }
    r.update(extra)
    return r


async def _resolve_preconditions(
    session: AsyncSession, principal: Principal, op: OperationIn
) -> dict[str, int]:
    expected: dict[str, int] = {}
    for pc in op.preconditions:
        key = f"{pc.entity}:{pc.id}"
        if pc.expected_version is not None and pc.after_operation_id is None:
            expected[key] = pc.expected_version
        elif pc.after_operation_id is not None and pc.expected_version is None:
            dep = await session.get(Operation, (principal.org_id, pc.after_operation_id))
            if dep is None:
                raise DependencyPending()
            if dep.state != "ACCEPTED":
                raise Conflict(
                    "DEPENDENCY_FAILED",
                    "An earlier operation this depends on was not accepted.",
                    details={"operation_id": str(dep.id), "state": dep.state},
                )
            v = (dep.result or {}).get("versions", {}).get(key)
            if v is None:
                raise DomainError(
                    "DEPENDENCY_INVALID", "Dependency did not produce that entity.", status_code=422
                )
            expected[key] = v
        else:
            raise DomainError(
                "INVALID_PRECONDITION", "Give expected_version or after_operation_id.", status_code=422
            )
    return expected


async def execute(
    session: AsyncSession,
    principal: Principal,
    op: OperationIn,
    *,
    device_id: uuid.UUID | None = None,
    online: bool = True,
) -> dict[str, Any]:
    spec = REGISTRY.get(op.type)
    if spec is None:
        return _receipt(
            op.operation_id, "REJECTED", code="UNKNOWN_COMMAND", message=f"Unknown command {op.type}."
        )
    h = payload_hash(op, device_id)
    try:
        async with session.begin():
            tx = DomainTx(
                session,
                principal,
                operation_id=op.operation_id,
                command_type=op.type,
                client_recorded_at=op.client_recorded_at,
            )
            await tx.lock_gate()
            existing = await session.get(Operation, (principal.org_id, op.operation_id))
            if existing is not None:
                if (
                    existing.payload_hash != h
                    or existing.type != op.type
                    or existing.actor_id != principal.user_id
                ):
                    return _receipt(
                        op.operation_id,
                        "REJECTED",
                        code="OPERATION_ID_REUSED",
                        message="This operation id was already used for a different command.",
                    )
                # Replay: no new mutation; sanitized original receipt (no entity projections).
                stored = dict(existing.result)
                stored.pop("entities", None)
                stored["replayed"] = True
                return stored

            try:
                payload = spec.payload_model.model_validate(op.payload)
            except ValidationError as exc:
                fields = {".".join(str(x) for x in e["loc"]) or "_": e["msg"] for e in exc.errors()}
                result = _receipt(
                    op.operation_id,
                    "REJECTED",
                    code="INVALID_INPUT",
                    message="The command payload is invalid.",
                    field_errors=fields,
                )
                await _persist(session, principal, op, device_id, h, "REJECTED", result)
                return result
            if spec.requires_aggregate and op.aggregate_id is None:
                result = _receipt(
                    op.operation_id, "REJECTED", code="INVALID_INPUT", message="aggregate_id is required."
                )
                await _persist(session, principal, op, device_id, h, "REJECTED", result)
                return result
            if spec.online_only and not online:
                raise Forbidden("This action is only available online in the console.", "ONLINE_ONLY")

            for dep_id in op.depends_on:
                dep = await session.get(Operation, (principal.org_id, dep_id))
                if dep is None:
                    raise DependencyPending()
            ctx = CommandCtx(tx=tx, op=op, expected={})
            state = "ACCEPTED"
            data: dict[str, Any] = {}
            error: DomainError | None = None
            try:
                for dep_id in op.depends_on:
                    dep = await session.get(Operation, (principal.org_id, dep_id))
                    if dep.state != "ACCEPTED":
                        raise Conflict(
                            "DEPENDENCY_FAILED",
                            "An earlier operation this depends on was not accepted. Review it first.",
                            details={"operation_id": str(dep_id), "state": dep.state},
                        )
                ctx.expected = await _resolve_preconditions(session, principal, op)
                seq_before = tx.sequence
                async with session.begin_nested() as sp:
                    try:
                        data = await spec.handler(ctx, payload)
                    except (DomainError, IntegrityError) as exc:
                        await sp.rollback()
                        tx.sequence = seq_before
                        tx.versions.clear()
                        tx.entities.clear()
                        raise exc
            except Forbidden:
                raise
            except IntegrityError as exc:
                log.warning("integrity error in %s: %s", op.type, exc.orig)
                error = Conflict(
                    "CONSTRAINT_CONFLICT", "The change conflicts with current data. Refresh and retry."
                )
            except DomainError as exc:
                error = exc

            if error is not None:
                state = "CONFLICT" if error.status_code == 409 else "REJECTED"
                if state == "CONFLICT" and spec.on_conflict is not None:
                    async with session.begin_nested():
                        await spec.on_conflict(ctx, payload, error)
                result = _receipt(
                    op.operation_id,
                    state,
                    code=error.code,
                    message=error.message,
                    field_errors=error.field_errors or None,
                    details=error.details or None,
                    versions=tx.versions,
                    entities=tx.entities,
                )
            else:
                result = _receipt(
                    op.operation_id, "ACCEPTED", data=data, versions=tx.versions, entities=tx.entities
                )
            await _persist(session, principal, op, device_id, h, state, result)
            await tx.finish()
        return result
    except DependencyPending as exc:
        return _receipt(
            op.operation_id,
            "DEPENDENCY_PENDING",
            code="DEPENDENCY_PENDING",
            message=exc.message,
            retryable=True,
        )
    except Forbidden as exc:
        # Not persisted: preserve the local record for supervised recovery (spec §18 403 handling).
        return _receipt(op.operation_id, "REJECTED", code=exc.code, message=exc.message, http_status=403)
    except DBAPIError as exc:
        log.exception("transient database failure for %s", op.operation_id)
        return _receipt(
            op.operation_id,
            "RETRY",
            code="TRANSIENT",
            message="Temporary server problem.",
            retryable=True,
            detail=type(exc).__name__,
        )


async def _persist(session, principal, op, device_id, h, state, result) -> None:
    session.add(
        Operation(
            id=op.operation_id,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            device_id=device_id,
            type=op.type,
            payload_hash=h,
            state=state,
            result=result,
            client_recorded_at=op.client_recorded_at,
        )
    )
    await session.flush()


async def get_receipt(session: AsyncSession, principal: Principal, op_id: uuid.UUID) -> dict | None:
    row = (
        await session.execute(
            select(Operation).where(Operation.org_id == principal.org_id, Operation.id == op_id)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    if row.actor_id != principal.user_id and "audit.read" not in principal.permissions:
        return None
    result = dict(row.result)
    result.pop("entities", None)
    return result
