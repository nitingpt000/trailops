"""Durable jobs: single scheduled instance per period, leasing, retry with terminal failure."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update

from app.core import db as dbmod
from app.jobs import worker
from app.models import Job


async def _jobs():
    async with dbmod.sessionmaker()() as s:
        return (await s.execute(select(Job).order_by(Job.created_at))).scalars().all()


async def test_scheduler_is_idempotent_per_period_and_jobs_complete():
    now = datetime(2026, 10, 13, 12, tzinfo=UTC)
    await worker.schedule_once(now)
    await worker.schedule_once(now + timedelta(minutes=1))  # same period: no duplicates
    jobs = await _jobs()
    assert sorted(j.type for j in jobs) == sorted(t for t, _ in worker.SCHEDULE)
    while await worker.run_one():
        pass
    assert {j.state for j in await _jobs()} == {"DONE"}


async def test_failing_job_retries_then_fails_terminally():
    async with dbmod.sessionmaker()() as s, s.begin():
        await worker.enqueue(s, "does.not.exist", unique_key="x")
    assert await worker.run_one()
    [job] = await _jobs()
    assert job.state == "FAILED" and job.last_error


async def test_expired_lease_is_picked_up_again():
    async with dbmod.sessionmaker()() as s, s.begin():
        await worker.enqueue(s, "attachments.flag_stale", unique_key="lease")
        await s.execute(update(Job).values(state="RUNNING", lease_until=func.now() - timedelta(minutes=1)))
    assert await worker.run_one()
    async with dbmod.sessionmaker()() as s:
        assert (await s.execute(select(func.count()).where(Job.state == "DONE"))).scalar() == 1
