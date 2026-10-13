import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal, current_principal
from app.core.db import get_session
from app.core.errors import Forbidden, InvalidInput
from app.core.settings import get_settings
from app.models import Device
from app.modules.attachments import service as attachments
from app.modules.commands.base import OperationIn
from app.modules.commands.processor import execute
from app.modules.sync import service

router = APIRouter(prefix="/v1")


class CommandBatch(BaseModel):
    protocol_version: int
    device_id: uuid.UUID
    operations: list[OperationIn] = Field(min_length=1, max_length=200)
    pending_count: int | None = Field(default=None, ge=0)


@router.post("/sync/bootstrap")
async def bootstrap(
    principal: Principal = Depends(current_principal), session: AsyncSession = Depends(get_session)
):
    return await service.bootstrap(session, principal)


@router.get("/sync/changes")
async def changes(
    cursor: str,
    limit: int = Query(200, ge=1, le=500),
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    return await service.changes(session, principal, cursor, limit)


@router.post("/sync/commands")
async def sync_commands(
    body: CommandBatch,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    s = get_settings()
    if body.protocol_version != s.sync_protocol_version:
        raise InvalidInput("PROTOCOL_UNSUPPORTED", "Please update the app to sync.")
    if len(body.operations) > s.max_command_batch:
        raise InvalidInput("BATCH_TOO_LARGE", f"At most {s.max_command_batch} operations per push.")
    if principal.device_id != body.device_id:
        raise Forbidden("Device header and batch device differ.", "DEVICE_MISMATCH")
    # Process in client order; entries whose dependency is later in the same batch get another pass.
    results: dict[uuid.UUID, dict] = {}
    pending = list(body.operations)
    for _ in range(3):
        progressed = False
        nxt = []
        for op in pending:
            r = await execute(session, principal, op, device_id=body.device_id, online=False)
            results[op.operation_id] = r
            if r["status"] == "DEPENDENCY_PENDING" and any(
                d in {o.operation_id for o in body.operations} for d in op.depends_on
            ):
                nxt.append(op)
            else:
                progressed = True
        pending = nxt
        if not pending or not progressed:
            break
    async with session.begin():
        dev = await session.get(Device, body.device_id)
        dev.last_seen_at = datetime.now(UTC)
        if body.pending_count is not None:
            dev.reported_pending = body.pending_count
            dev.reported_pending_at = datetime.now(UTC)
    # Transport success does not imply every operation succeeded: inspect each receipt.
    return {
        "protocol_version": s.sync_protocol_version,
        "results": [results[op.operation_id] for op in body.operations],
    }


@router.post("/commands")
async def console_command(
    op: OperationIn,
    response: Response,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    """Online console mutations use the same processor and operation ids as queued mobile commands."""
    r = await execute(session, principal, op, device_id=None, online=True)
    response.status_code = {
        "ACCEPTED": 200,
        "CONFLICT": 409,
        "DEPENDENCY_PENDING": 409,
        "RETRY": 503,
    }.get(r["status"], r.get("http_status", 422))
    return r


@router.post("/attachments/{attachment_id}/initiate")
async def initiate(
    attachment_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    return await attachments.initiate(session, principal, attachment_id)


@router.post("/attachments/initiate")
async def initiate_body(
    body: dict,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    try:
        attachment_id = uuid.UUID(str(body.get("attachment_id")))
    except ValueError as exc:
        raise InvalidInput("INVALID_INPUT", "attachment_id required") from exc
    return await attachments.initiate(session, principal, attachment_id)


@router.put("/attachments/{attachment_id}/content")
async def put_content(
    attachment_id: uuid.UUID, token: str, request: Request, session: AsyncSession = Depends(get_session)
):
    limit = get_settings().max_photo_bytes
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise InvalidInput("PHOTO_TOO_LARGE", "Upload exceeds the size limit.")
    await attachments.put_content(session, attachment_id, token, bytes(data))
    return {"stored": True}


@router.get("/attachments/{attachment_id}/content")
async def get_content(attachment_id: uuid.UUID, token: str, session: AsyncSession = Depends(get_session)):
    from app.core.errors import NotFound
    from app.models import Attachment

    attachments.check_slot_token(token, attachment_id, "download")
    att = await session.get(Attachment, attachment_id)
    if att is None or att.state != "VERIFIED":
        raise NotFound()
    data = attachments.storage().read(att.object_key)
    return Response(content=data, media_type=att.mime, headers={"Cache-Control": "private, max-age=300"})


@router.post("/attachments/{attachment_id}/complete")
async def complete(
    attachment_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    return await attachments.complete(session, principal, attachment_id)


@router.get("/attachments/{attachment_id}/download")
async def download(
    attachment_id: uuid.UUID,
    principal: Principal = Depends(current_principal),
    session: AsyncSession = Depends(get_session),
):
    return await attachments.download(session, principal, attachment_id)
