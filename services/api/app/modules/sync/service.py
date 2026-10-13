"""Bootstrap snapshot and commit-ordered change stream (spec §18).

Cursors are HMAC-signed and bound to org, user and scope epoch, so a client cannot skip events by
inventing a high cursor, and a scope change forces a re-bootstrap.
"""

import base64
import hashlib
import hmac
import json
import uuid
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal
from app.core.errors import DomainError, InvalidInput
from app.core.projections import ENTITY_TYPES, ORG_WIDE, ProjectionContext, visible
from app.core.settings import get_settings
from app.models import ChangeLog, EntityScope, SyncSequence

BOOTSTRAP_ORDER = [
    "camp",
    "location",
    "category",
    "form_definition",
    "form_version",
    "batch",
    "batch_member",
    "equipment",
    "allocation",
    "inspection",
    "attachment",
    "repair",
    "transfer",
    "transfer_line",
    "custody_claim",
    "conflict",
]
MAX_SCAN = 500


def _sign(body: dict) -> str:
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    mac = hmac.new(get_settings().signing_secret.encode(), raw, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(raw + b"." + mac).decode().rstrip("=")


def make_cursor(principal: Principal, sequence: int, generation: str) -> str:
    return _sign(
        {
            "o": str(principal.org_id),
            "u": str(principal.user_id),
            "e": principal.scope_epoch,
            "s": sequence,
            "g": generation,
        }
    )


def read_cursor(principal: Principal, cursor: str) -> dict:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        blob = base64.urlsafe_b64decode(padded.encode())
        raw, mac = blob[:-17], blob[-16:]  # fixed-size MAC; never split on a byte value
        expect = hmac.new(get_settings().signing_secret.encode(), raw, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(mac, expect):
            raise ValueError("mac")
        body = json.loads(raw)
    except Exception as exc:
        raise InvalidInput("INVALID_CURSOR", "Sync cursor is invalid. Download again.") from exc
    if body["o"] != str(principal.org_id) or body["u"] != str(principal.user_id):
        raise InvalidInput("INVALID_CURSOR", "Sync cursor belongs to another account.")
    if body["e"] != principal.scope_epoch:
        raise DomainError(
            "RESYNC_REQUIRED",
            "Your access changed. A fresh download is required.",
            status_code=409,
            details={"reason": "SCOPE_CHANGED"},
        )
    return body


def _scope_filter(principal: Principal):
    conds = [EntityScope.scope.contains([ORG_WIDE])]
    if principal.org_wide:
        conds.append(func.jsonb_array_length(EntityScope.scope) > 0)
    for camp in principal.scope_strings():
        conds.append(EntityScope.scope.contains([camp]))
    return or_(*conds)


async def bootstrap(session: AsyncSession, principal: Principal) -> dict[str, Any]:
    """Consistent scoped snapshot + high-watermark from one REPEATABLE READ transaction."""
    await session.rollback()
    await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    await session.execute(text("SET TRANSACTION READ ONLY"))
    try:
        seq = (
            await session.execute(
                select(SyncSequence.last_sequence).where(SyncSequence.org_id == principal.org_id)
            )
        ).scalar() or 0
        proj = ProjectionContext(session)
        records: dict[str, list[dict]] = {}
        for entity in BOOTSTRAP_ORDER:
            model = ENTITY_TYPES[entity]
            ids = (
                (
                    await session.execute(
                        select(EntityScope.entity_id).where(
                            EntityScope.org_id == principal.org_id,
                            EntityScope.entity_type == entity,
                            _scope_filter(principal),
                        )
                    )
                )
                .scalars()
                .all()
            )
            rows = []
            if ids:
                objs = (await session.execute(select(model).where(model.id.in_(ids)))).scalars().all()
                for obj in objs:
                    rows.append(await proj.serialize(entity, obj))
            records[entity] = rows
    finally:
        await session.rollback()
    generation = uuid.uuid4().hex[:12]
    return {
        "protocol_version": get_settings().sync_protocol_version,
        "scope_epoch": principal.scope_epoch,
        "generation": generation,
        "high_watermark": seq,
        "records": records,
        "cursor": make_cursor(principal, seq, generation),
    }


async def changes(session: AsyncSession, principal: Principal, cursor: str, limit: int) -> dict[str, Any]:
    body = read_cursor(principal, cursor)
    after = int(body["s"])
    limit = max(1, min(limit, MAX_SCAN))
    oldest = (
        await session.execute(
            select(func.min(ChangeLog.sequence)).where(ChangeLog.org_id == principal.org_id)
        )
    ).scalar()
    last = (
        await session.execute(
            select(SyncSequence.last_sequence).where(SyncSequence.org_id == principal.org_id)
        )
    ).scalar() or 0
    if (oldest is None and last > after) or (oldest is not None and after < oldest - 1):
        raise DomainError(
            "CURSOR_EXPIRED",
            "Sync history has expired for this device. Download again.",
            status_code=410,
            details={"reason": "RETENTION"},
        )
    rows = (
        (
            await session.execute(
                select(ChangeLog)
                .where(ChangeLog.org_id == principal.org_id, ChangeLog.sequence > after)
                .order_by(ChangeLog.sequence)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    scopes = principal.scope_strings()
    out = []
    for r in rows:
        if not r.deleted and visible(r.after_scope, scopes, principal.org_wide):
            out.append(
                {
                    "sequence": r.sequence,
                    "entity": r.entity_type,
                    "id": str(r.entity_id),
                    "version": r.version,
                    "deleted": False,
                    "data": r.payload,
                }
            )
        elif visible(r.before_scope, scopes, principal.org_wide):
            # Moved out of scope or deleted: tombstone, never silently omitted (spec §18).
            out.append(
                {
                    "sequence": r.sequence,
                    "entity": r.entity_type,
                    "id": str(r.entity_id),
                    "version": r.version,
                    "deleted": True,
                    "data": None,
                }
            )
    # next_cursor = last *scanned* sequence, including invisible events.
    next_seq = rows[-1].sequence if rows else after
    await session.rollback()
    return {
        "protocol_version": get_settings().sync_protocol_version,
        "scope_epoch": principal.scope_epoch,
        "changes": out,
        "next_cursor": make_cursor(principal, next_seq, body["g"]),
        "has_more": len(rows) == limit,
    }
