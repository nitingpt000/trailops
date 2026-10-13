"""Durable job worker (spec §23).

Jobs live in PostgreSQL. Workers lease them with `FOR UPDATE SKIP LOCKED` and a bounded lease, so
several worker processes can run safely and a crashed worker's job becomes available again when its
lease expires. Handlers are idempotent. Timed jobs are enqueued by exactly one scheduler loop (run
with `--scheduler`), using a per-period unique key so duplicate enqueues are ignored.

    uv run python -m app.jobs.worker --scheduler
"""

import argparse
import asyncio
import logging
import traceback
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import sessionmaker
from app.core.settings import get_settings
from app.models import Attachment, ChangeLog, Job, Operation

log = logging.getLogger("trailops.jobs")
LEASE = timedelta(minutes=5)

Handler = Callable[[AsyncSession, dict], Awaitable[dict]]
HANDLERS: dict[str, Handler] = {}


def handler(name: str):
    def deco(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        return fn

    return deco


@handler("retention.change_log")
async def prune_change_log(session: AsyncSession, payload: dict) -> dict:
    """Clients with older cursors get CURSOR_EXPIRED and re-bootstrap (spec §6 data lifecycle)."""
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().change_retention_days)
    res = await session.execute(delete(ChangeLog).where(ChangeLog.recorded_at < cutoff))
    return {"deleted": res.rowcount}


@handler("retention.operations")
async def prune_operations(session: AsyncSession, payload: dict) -> dict:
    """Receipts are kept longer than any offline/retry window so replays stay idempotent."""
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().operation_retention_days)
    res = await session.execute(delete(Operation).where(Operation.received_at < cutoff))
    return {"deleted": res.rowcount}


@handler("attachments.flag_stale")
async def flag_stale_uploads(session: AsyncSession, payload: dict) -> dict:
    """Evidence placeholders never uploaded within the window are reported, never deleted:
    the device still holds the file and will retry. Reported count feeds monitoring."""
    cutoff = datetime.now(UTC) - timedelta(days=int(payload.get("days", 7)))
    n = (
        await session.execute(
            select(func.count())
            .select_from(Attachment)
            .where(Attachment.state.in_(["PENDING", "INITIATED"]), Attachment.created_at < cutoff)
        )
    ).scalar()
    if n:
        log.warning("stale evidence uploads", extra={"count": n})
    return {"stale": n}


SCHEDULE = [("retention.change_log", timedelta(hours=24)), ("retention.operations", timedelta(hours=24)),
            ("attachments.flag_stale", timedelta(hours=6))]


async def enqueue(session: AsyncSession, type_: str, payload: dict | None = None, unique_key: str | None = None):
    await session.execute(
        pg_insert(Job).values(type=type_, payload=payload or {}, state="READY", unique_key=unique_key)
        .on_conflict_do_nothing(index_elements=["unique_key"])
    )


async def schedule_once(now: datetime | None = None) -> None:
    now = now or datetime.now(UTC)
    async with sessionmaker()() as session, session.begin():
        for type_, every in SCHEDULE:
            period = int(now.timestamp() // every.total_seconds())
            await enqueue(session, type_, unique_key=f"{type_}:{period}")


async def run_one() -> bool:
    """Lease and run one job. Returns False if nothing was ready."""
    async with sessionmaker()() as session:
        async with session.begin():
            # Database time only: host and database clocks can differ (spec §5: no device/host clock ordering).
            now = (await session.execute(select(func.now()))).scalar_one()
            job = (
                await session.execute(
                    select(Job)
                    .where(or_(and_(Job.state == "READY", Job.available_at <= now),
                               and_(Job.state == "RUNNING", Job.lease_until < now)))
                    .order_by(Job.available_at)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
            ).scalar_one_or_none()
            if job is None:
                return False
            job.state = "RUNNING"
            job.attempts += 1
            job.lease_until = now + LEASE
            job_id, job_type, payload = job.id, job.type, job.payload
            attempts, max_attempts = job.attempts, job.max_attempts
        try:
            fn = HANDLERS[job_type]
            async with session.begin():
                result = await fn(session, payload)
            async with session.begin():
                await session.execute(update(Job).where(Job.id == job_id).values(state="DONE", last_error=None,
                                                                                 lease_until=None))
            log.info("job done", extra={"job": job_type, "result": result})
        except Exception as exc:  # noqa: BLE001 - recorded on the job row
            terminal = attempts >= max_attempts or job_type not in HANDLERS
            backoff = timedelta(seconds=min(3600, 30 * 2 ** attempts))
            async with session.begin():
                await session.execute(
                    update(Job).where(Job.id == job_id).values(
                        state="FAILED" if terminal else "READY", available_at=func.now() + backoff,
                        lease_until=None, last_error="".join(traceback.format_exception_only(exc))[:2000],
                    )
                )
            log.error("job failed", extra={"job": job_type, "terminal": terminal})
        return True


async def main(scheduler: bool, once: bool) -> None:
    last_schedule = datetime.min.replace(tzinfo=UTC)
    while True:
        if scheduler and datetime.now(UTC) - last_schedule > timedelta(minutes=5):
            await schedule_once()
            last_schedule = datetime.now(UTC)
        ran = await run_one()
        if once and not ran:
            return
        if not ran:
            await asyncio.sleep(5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--scheduler", action="store_true", help="also enqueue timed jobs (run in ONE process only)")
    ap.add_argument("--once", action="store_true", help="drain ready jobs then exit")
    a = ap.parse_args()
    asyncio.run(main(a.scheduler, a.once))
