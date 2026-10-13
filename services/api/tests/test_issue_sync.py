"""ISSUE-01..03, SYNC-01..10, CONFLICT-01..02."""

import asyncio
import uuid

from conftest import issue_op, return_op, sid
from sqlalchemy import func, select

from app.core import db as dbmod
from app.models import Allocation, ChangeLog, Operation


async def _bootstrap(api, user):
    r = await api.c.post("/v1/sync/bootstrap", headers=api.headers(user, True))
    assert r.status_code == 200, r.text
    return r.json()


async def test_issue01_valid_issue_creates_active_allocation(api):
    [r] = await api.push("aditi", issue_op("JKT-018", expected_version=1))
    assert r["status"] == "ACCEPTED", r
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    assert item["status"] == "ISSUED"
    assert item["allocation"]["trekker_name"] == "Priya Nair"
    assert r["versions"][f"equipment:{sid('item:JKT-018')}"] == 2


async def test_issue_non_member_and_due_date_policy(api):
    [r] = await api.push("aditi", issue_op("JKT-018", trekker="Aman Verma"))  # Kedarkantha trekker
    assert r["code"] == "NOT_BATCH_MEMBER"
    op = issue_op("JKT-018")
    op["payload"]["due_date"] = "2027-01-01"
    [r] = await api.push("aditi", op)
    assert r["code"] == "DUE_DATE_OUT_OF_POLICY"


async def test_issue02_two_devices_same_item_one_wins_one_conflict(api):
    await api.device("aditi")
    await api.device("ramesh")
    a, b = issue_op("JKT-018", trekker="Priya Nair"), issue_op("JKT-018", trekker="Karan Malhotra")
    ra, rb = await asyncio.gather(api.push("aditi", a), api.push("ramesh", b))
    statuses = sorted([ra[0]["status"], rb[0]["status"]])
    assert statuses == ["ACCEPTED", "CONFLICT"], (ra, rb)
    loser = ra[0] if ra[0]["status"] == "CONFLICT" else rb[0]
    assert loser["code"] == "ITEM_ALREADY_ALLOCATED"
    async with dbmod.sessionmaker()() as s:
        n = (
            await s.execute(
                select(func.count())
                .select_from(Allocation)
                .where(Allocation.item_id == sid("item:JKT-018"), Allocation.state == "ACTIVE")
            )
        ).scalar()
    assert n == 1
    # The losing claim is preserved as a reviewable conflict + custody claim (CONFLICT-02).
    conflicts = (await api.get("ananya", "/v1/conflicts")).json()
    assert len(conflicts["conflicts"]) == 1
    assert conflicts["conflicts"][0]["details"]["proposed"]["trekker_name"] in (
        "Priya Nair",
        "Karan Malhotra",
    )
    assert any(c["source_type"] == "ALLOCATION_CONFLICT" for c in conflicts["custody_claims"])


async def test_issue03_unavailable_states_rejected(api):
    [r] = await api.push("ananya", issue_op("JKT-022", trekker="Aman Verma", batch="KDK-1014"))  # in transit
    assert r["status"] == "CONFLICT" and r["code"] == "ITEM_NOT_AVAILABLE"


async def test_sync01_lost_response_retry_returns_same_receipt(api):
    op = issue_op("JKT-018")
    [first] = await api.push("aditi", op)
    [second] = await api.push("aditi", op)
    assert first["status"] == second["status"] == "ACCEPTED"
    assert second["replayed"] is True
    assert second["data"] == first["data"]
    async with dbmod.sessionmaker()() as s:
        n = (
            await s.execute(
                select(func.count()).select_from(Allocation).where(Allocation.item_id == sid("item:JKT-018"))
            )
        ).scalar()
    assert n == 1


async def test_sync02_reused_operation_id_with_altered_payload(api):
    op = issue_op("JKT-018")
    await api.push("aditi", op)
    altered = dict(op, payload=dict(op["payload"], due_date=(op["payload"]["due_date"][:-2] + "15")))
    [r] = await api.push("aditi", altered)
    assert r["status"] == "REJECTED" and r["code"] == "OPERATION_ID_REUSED"


async def test_sync05_concurrent_commits_commit_ordered_cursor(api):
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    tags = ["JKT-018", "JKT-019", "JKT-020", "JKT-021", "SHO-007", "SHO-008", "SHO-009", "SBG-007"]
    trekkers = [
        "Priya Nair",
        "Karan Malhotra",
        "Isha Kapoor",
        "Sneha Patil",
        "Priya Nair",
        "Karan Malhotra",
        "Isha Kapoor",
        "Sneha Patil",
    ]

    async def one(tag, who):
        return await api.push("aditi", issue_op(tag, trekker=who))

    pulled: list[dict] = []
    cursor = boot["cursor"]

    async def puller():
        nonlocal cursor
        for _ in range(30):
            r = (await api.get("aditi", "/v1/sync/changes", cursor=cursor, limit=3)).json()
            pulled.extend(r["changes"])
            cursor = r["next_cursor"]
            await asyncio.sleep(0)

    await asyncio.gather(*(one(t, w) for t, w in zip(tags, trekkers, strict=True)), puller())
    while True:
        r = (await api.get("aditi", "/v1/sync/changes", cursor=cursor, limit=50)).json()
        pulled.extend(r["changes"])
        cursor = r["next_cursor"]
        if not r["has_more"]:
            break
    seqs = [c["sequence"] for c in pulled]
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))
    issued = {
        c["data"]["tag"] for c in pulled if c["entity"] == "equipment" and c["data"]["status"] == "ISSUED"
    }
    assert issued == set(tags)
    async with dbmod.sessionmaker()() as s:
        all_seqs = (
            (
                await s.execute(
                    select(ChangeLog.sequence)
                    .where(ChangeLog.sequence > boot["high_watermark"])
                    .order_by(ChangeLog.sequence)
                )
            )
            .scalars()
            .all()
        )
    assert all_seqs == list(range(boot["high_watermark"] + 1, boot["high_watermark"] + 1 + len(all_seqs)))


async def test_bootstrap_is_scoped(api):
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    tags = {e["tag"] for e in boot["records"]["equipment"]}
    assert "JKT-014" in tags and "JKT-023" not in tags
    # In-transit items heading to Lohajung are visible as authorized references.
    assert "JKT-022" in tags
    assert {b["code"] for b in boot["records"]["batch"]} == {"BRT-1012", "ALB-1015"}
    assert all(v["status"] != "DRAFT" for v in boot["records"]["form_version"])


async def test_sync06_item_moving_out_of_scope_sends_tombstone(api):
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    res = await api.cmd(
        "ananya",
        "DISPATCH_TRANSFER",
        uuid.uuid4(),
        {
            "from_location_id": str(sid("loc:Lohajung Store")),
            "to_location_id": str(sid("loc:Sankri Store")),
            "item_ids": [str(sid("item:JKT-018"))],
        },
    )
    assert res["status"] == "ACCEPTED", res
    # Still visible while in transit from Lohajung.
    r = (await api.get("aditi", "/v1/sync/changes", cursor=boot["cursor"])).json()
    eq = [c for c in r["changes"] if c["entity"] == "equipment"]
    assert eq and not eq[-1]["deleted"]
    transfer_id = res["data"]["transfer_id"]
    line = (await api.get("ananya", "/v1/transfers")).json()["items"]
    line = next(t for t in line if t["id"] == transfer_id)["lines"][0]
    rec = await api.cmd(
        "ananya",
        "RECEIVE_TRANSFER",
        transfer_id,
        {"lines": [{"item_id": line["item_id"], "result": "RECEIVED"}]},
    )
    assert rec["status"] == "ACCEPTED", rec
    r2 = (await api.get("aditi", "/v1/sync/changes", cursor=r["next_cursor"])).json()
    tomb = [c for c in r2["changes"] if c["entity"] == "equipment" and c["id"] == str(sid("item:JKT-018"))]
    assert tomb and tomb[-1]["deleted"] is True and tomb[-1]["data"] is None


async def test_sync07_scope_change_forces_rebootstrap(api):
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    await api.cmd(
        "kabir",
        "MEMBERSHIP_UPDATE",
        None,
        {"user_id": str(sid("user:aditi")), "camp_id": str(sid("camp:SNK")), "enabled": True},
    )
    r = await api.get("aditi", "/v1/sync/changes", cursor=boot["cursor"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "RESYNC_REQUIRED"
    boot2 = await _bootstrap(api, "aditi")
    assert "JKT-023" in {e["tag"] for e in boot2["records"]["equipment"]}


async def test_forged_cursor_rejected(api):
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    forged = boot["cursor"][:-3] + ("AAA" if not boot["cursor"].endswith("AAA") else "BBB")
    r = await api.get("aditi", "/v1/sync/changes", cursor=forged)
    assert r.status_code == 422
    r = await api.get("ananya", "/v1/sync/changes", cursor=boot["cursor"])
    assert r.status_code == 422


async def test_sync09_replay_after_role_removed_returns_sanitized_receipt(api):
    op = issue_op("JKT-018")
    [first] = await api.push("aditi", op)
    assert first["status"] == "ACCEPTED"
    await api.cmd(
        "kabir",
        "MEMBERSHIP_UPDATE",
        None,
        {"user_id": str(sid("user:aditi")), "camp_id": str(sid("camp:LHJ")), "enabled": False},
    )
    [again] = await api.push("aditi", op)
    assert again["status"] == "ACCEPTED" and again["replayed"]
    assert "entities" not in again


async def test_sync10_one_failed_command_does_not_block_others(api):
    good = issue_op("JKT-018")
    bad = issue_op("JKT-019", trekker="Aman Verma")
    also_good = issue_op("SHO-007")
    res = await api.push("aditi", good, bad, also_good)
    assert [r["status"] for r in res] == ["ACCEPTED", "REJECTED", "ACCEPTED"]


async def test_offline_issue_then_return_chain_with_after_operation_precondition(api):
    issue = issue_op("JKT-018", expected_version=1)
    alloc = issue["payload"]["allocation_id"]
    ret = return_op(
        "JKT-018",
        alloc,
        depends_on=[issue["operation_id"]],
        preconditions=[
            {
                "entity": "equipment",
                "id": str(sid("item:JKT-018")),
                "after_operation_id": issue["operation_id"],
            }
        ],
    )
    # Return arrives first in the batch order; the server processes the dependency, then retries.
    res = await api.push("aditi", ret, issue)
    assert [r["status"] for r in res] == ["ACCEPTED", "ACCEPTED"], res


async def test_dependent_return_blocked_when_issue_conflicted(api):
    await api.device("ramesh")
    winner = issue_op("JKT-018", trekker="Karan Malhotra")
    assert (await api.push("ramesh", winner))[0]["status"] == "ACCEPTED"
    issue = issue_op("JKT-018")
    ret = return_op("JKT-018", issue["payload"]["allocation_id"], depends_on=[issue["operation_id"]])
    r1, r2 = await api.push("aditi", issue, ret)
    assert r1["status"] == "CONFLICT"
    assert r2["status"] == "CONFLICT" and r2["code"] == "DEPENDENCY_FAILED"
    # The winning allocation was not closed by the stray return.
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    assert item["status"] == "ISSUED" and item["allocation"]["trekker_name"] == "Karan Malhotra"


async def test_conflict01_replacement_taken_keeps_conflict_open(api):
    await api.device("ramesh")
    await api.push("ramesh", issue_op("JKT-018", trekker="Karan Malhotra"))
    [lost] = await api.push("aditi", issue_op("JKT-018", trekker="Priya Nair"))
    assert lost["status"] == "CONFLICT"
    conflict = (await api.get("ananya", "/v1/conflicts")).json()["conflicts"][0]
    # Replacement JKT-019 gets taken by someone else first.
    await api.push("ramesh", issue_op("JKT-019", trekker="Isha Kapoor"))
    res = await api.cmd(
        "aditi",
        "RESOLVE_ALLOCATION_CONFLICT",
        conflict["id"],
        {
            "resolution": "REPLACE",
            "note": "Gave a different jacket",
            "replacement": {
                "item_id": str(sid("item:JKT-019")),
                "allocation_id": str(uuid.uuid4()),
                "due_date": "2026-10-17",
            },
        },
    )
    assert res["status"] == "CONFLICT" and res["code"] == "ITEM_ALREADY_ALLOCATED"
    still = (await api.get("ananya", "/v1/conflicts")).json()["conflicts"]
    assert len(still) == 1 and still[0]["state"] == "OPEN"
    # Now a free replacement succeeds atomically; confirmed recipient keeps the original.
    res = await api.cmd(
        "aditi",
        "RESOLVE_ALLOCATION_CONFLICT",
        conflict["id"],
        {
            "resolution": "REPLACE",
            "note": "Swapped to JKT-020 at handover",
            "replacement": {
                "item_id": str(sid("item:JKT-020")),
                "allocation_id": str(uuid.uuid4()),
                "due_date": "2026-10-17",
            },
        },
    )
    assert res["status"] == "ACCEPTED", res
    assert (await api.get("ananya", "/v1/conflicts")).json()["conflicts"] == []
    j18 = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    j20 = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-020')}")).json()
    assert j18["allocation"]["trekker_name"] == "Karan Malhotra"
    assert j20["allocation"]["trekker_name"] == "Priya Nair"
    assert j18["open_claims"] == 0


async def test_conflict_cancel_does_not_release_confirmed_item(api):
    await api.device("ramesh")
    await api.push("ramesh", issue_op("JKT-018", trekker="Karan Malhotra"))
    await api.push("aditi", issue_op("JKT-018", trekker="Priya Nair"))
    conflict = (await api.get("ananya", "/v1/conflicts")).json()["conflicts"][0]
    res = await api.cmd(
        "aditi",
        "RESOLVE_ALLOCATION_CONFLICT",
        conflict["id"],
        {"resolution": "CANCEL_LOCAL_CLAIM", "note": "Retrieved jacket from Priya"},
    )
    assert res["status"] == "ACCEPTED"
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    assert item["status"] == "ISSUED" and item["allocation"]["trekker_name"] == "Karan Malhotra"
    again = await api.cmd(
        "aditi",
        "RESOLVE_ALLOCATION_CONFLICT",
        conflict["id"],
        {"resolution": "CANCEL_LOCAL_CLAIM", "note": "dup"},
    )
    assert again["code"] == "CONFLICT_ALREADY_RESOLVED"


async def test_reassign_requires_supervisor(api):
    await api.device("ramesh")
    await api.push("ramesh", issue_op("JKT-018", trekker="Karan Malhotra"))
    await api.push("aditi", issue_op("JKT-018", trekker="Priya Nair"))
    conflict = (await api.get("ananya", "/v1/conflicts")).json()["conflicts"][0]
    body = {
        "resolution": "REASSIGN",
        "note": "Priya physically has it",
        "reassign_allocation_id": str(uuid.uuid4()),
    }
    assert (await api.cmd("aditi", "RESOLVE_ALLOCATION_CONFLICT", conflict["id"], body))[
        "code"
    ] == "FORBIDDEN"
    res = await api.cmd("ananya", "RESOLVE_ALLOCATION_CONFLICT", conflict["id"], body)
    assert res["status"] == "ACCEPTED", res
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    assert item["allocation"]["trekker_name"] == "Priya Nair"


async def test_operation_receipt_endpoint(api):
    op = issue_op("JKT-018")
    await api.push("aditi", op)
    r = await api.get("aditi", f"/v1/operations/{op['operation_id']}")
    assert r.status_code == 200 and r.json()["status"] == "ACCEPTED"
    assert (await api.get("ramesh", f"/v1/operations/{op['operation_id']}")).status_code == 404
    async with dbmod.sessionmaker()() as s:
        row = await s.get(Operation, (sid("org"), uuid.UUID(op["operation_id"])))
    assert row.state == "ACCEPTED"


async def test_cursor_roundtrip_is_stable_for_many_sequences(api):
    from app.core.auth import resolve_principal
    from app.modules.sync.service import make_cursor, read_cursor

    async with dbmod.sessionmaker()() as s:
        principal = await resolve_principal(s, str(sid("user:aditi")), None)
    for seq in range(0, 3000, 7):
        assert read_cursor(principal, make_cursor(principal, seq, "g"))["s"] == seq


async def test_revoking_camp_access_forces_rebootstrap_and_purges_data(api):
    """Regression: revocation used to leave the scope epoch unchanged, so devices kept revoked data."""
    await api.device("aditi")
    boot = await _bootstrap(api, "aditi")
    assert any(e["tag"] == "JKT-014" for e in boot["records"]["equipment"])
    res = await api.cmd("kabir", "MEMBERSHIP_UPDATE", None, {"user_id": str(sid("user:aditi")),
                        "camp_id": str(sid("camp:LHJ")), "enabled": False})
    assert res["status"] == "ACCEPTED"
    r = await api.get("aditi", "/v1/sync/changes", cursor=boot["cursor"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "RESYNC_REQUIRED"
    boot2 = await _bootstrap(api, "aditi")
    assert boot2["records"]["equipment"] == [] and boot2["records"]["batch"] == []
    assert boot2["scope_epoch"] > boot["scope_epoch"]
    # Re-granting changes the epoch again (no reuse of an old value).
    await api.cmd("kabir", "MEMBERSHIP_UPDATE", None, {"user_id": str(sid("user:aditi")),
                  "camp_id": str(sid("camp:LHJ")), "enabled": True})
    boot3 = await _bootstrap(api, "aditi")
    assert boot3["scope_epoch"] > boot2["scope_epoch"] and boot3["records"]["equipment"]
