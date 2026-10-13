"""Demo helper (spec §28 step 4): a second actor issues an item through the same command processor.

    uv run python -m app.demo.second_device JKT-018 "Karan Malhotra" --as ramesh
"""

import argparse
import asyncio
import uuid
from datetime import timedelta

from app.core.auth import resolve_principal
from app.core.db import sessionmaker
from app.demo.seed import TODAY, sid
from app.modules.commands.base import OperationIn
from app.modules.commands.processor import execute


async def main(tag: str, trekker: str, actor: str, batch: str) -> None:
    async with sessionmaker()() as session:
        principal = await resolve_principal(session, str(sid(f"user:{actor}")), None)
        await session.rollback()
        op = OperationIn(
            operation_id=uuid.uuid4(), type="ISSUE_GEAR", aggregate_id=sid(f"item:{tag}"),
            payload={"allocation_id": str(uuid.uuid4()), "trekker_id": str(sid(f"trekker:{trekker}")),
                     "batch_id": str(sid(f"batch:{batch}")), "due_date": (TODAY + timedelta(days=4)).isoformat()},
        )
        r = await execute(session, principal, op, online=True)
        print(r["status"], r.get("code") or "", r.get("message") or "")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("tag")
    ap.add_argument("trekker")
    ap.add_argument("--as", dest="actor", default="ramesh")
    ap.add_argument("--batch", default="BRT-1012")
    a = ap.parse_args()
    asyncio.run(main(a.tag, a.trekker, a.actor, a.batch))
