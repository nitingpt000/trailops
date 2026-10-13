"""Regression tests for issues found while building the web console."""

import uuid

from conftest import descriptor, issue_op, jpeg_bytes, return_op, sid

LHJ = str(sid("loc:Lohajung Store"))
SNK = str(sid("loc:Sankri Store"))


async def _dispatch(api, user, tags, src, dst):
    tid = uuid.uuid4()
    res = await api.cmd(
        user,
        "DISPATCH_TRANSFER",
        tid,
        {"from_location_id": src, "to_location_id": dst, "item_ids": [str(sid(f"item:{t}")) for t in tags]},
    )
    assert res["status"] == "ACCEPTED", res
    return tid


async def test_extra_items_only_handover_can_be_reconciled(api):
    tid = await _dispatch(api, "ananya", ["JKT-018"], LHJ, SNK)
    rec = await api.cmd(
        "ananya",
        "RECEIVE_TRANSFER",
        tid,
        {
            "lines": [{"item_id": str(sid("item:JKT-018")), "result": "RECEIVED"}],
            "extra_items": [{"tag": "BPK-016"}, {"tag": "ZZZ-999"}],
        },
    )
    assert rec["data"]["state"] == "DISCREPANCY"
    claim = next(
        c
        for c in (await api.get("ananya", "/v1/conflicts")).json()["custody_claims"]
        if c["source_type"] == "TRANSFER_EXTRA"
    )
    res = await api.cmd(
        "ananya",
        "RESOLVE_CUSTODY_CLAIM",
        claim["id"],
        {"location_id": SNK, "note": "Checked"},
        preconditions=[{"entity": "custody_claim", "id": claim["id"], "expected_version": 1}],
    )
    assert res.get("status") == "ACCEPTED", res
    tr = next(t for t in (await api.get("ananya", "/v1/transfers")).json()["items"] if t["id"] == str(tid))
    assert tr["state"] == "RECONCILED"


async def test_unknown_extra_tags_alone_are_notes_not_discrepancy(api):
    tid = await _dispatch(api, "ananya", ["JKT-018"], LHJ, SNK)
    rec = await api.cmd(
        "ananya",
        "RECEIVE_TRANSFER",
        tid,
        {"lines": [{"item_id": str(sid("item:JKT-018")), "result": "RECEIVED"}], "extra_items": [{"tag": "ZZZ-999"}]},
    )
    assert rec["data"]["state"] == "RECEIVED"
    tr = next(t for t in (await api.get("ananya", "/v1/transfers")).json()["items"] if t["id"] == str(tid))
    assert "ZZZ-999" in tr["receipt_notes"]


async def test_discrepancy_resolution_checks_line_version(api):
    tid = await _dispatch(api, "ananya", ["JKT-018"], LHJ, SNK)
    await api.cmd(
        "ananya", "RECEIVE_TRANSFER", tid, {"lines": [{"item_id": str(sid("item:JKT-018")), "result": "MISSING"}]}
    )
    line = next(t for t in (await api.get("ananya", "/v1/transfers")).json()["items"] if t["id"] == str(tid))["lines"][
        0
    ]
    stale = await api.cmd(
        "ananya",
        "RESOLVE_TRANSFER_DISCREPANCY",
        line["id"],
        {"finding": "LOST", "reason": "Gone"},
        preconditions=[{"entity": "transfer_line", "id": line["id"], "expected_version": 1}],
    )
    assert stale["code"] == "VERSION_CONFLICT"
    ok = await api.cmd(
        "ananya",
        "RESOLVE_TRANSFER_DISCREPANCY",
        line["id"],
        {"finding": "LOST", "reason": "Gone"},
        preconditions=[{"entity": "transfer_line", "id": line["id"], "expected_version": line["version"]}],
    )
    assert ok["status"] == "ACCEPTED" and ok["data"]["transfer_state"] == "RECONCILED"


async def test_receiving_camp_sees_missing_item_claim(api):
    # Sankri → Lohajung; the missing item stays at Sankri, but Aditi (Lohajung only) must see the claim.
    tid = await _dispatch(api, "ananya", ["JKT-023"], SNK, LHJ)
    await api.cmd(
        "ananya", "RECEIVE_TRANSFER", tid, {"lines": [{"item_id": str(sid("item:JKT-023")), "result": "MISSING"}]}
    )
    claims = (await api.get("aditi", "/v1/conflicts")).json()["custody_claims"]
    assert any(c["item_tag"] == "JKT-023" and c["source_type"] == "TRANSFER_MISSING" for c in claims)


async def test_repair_queue_shows_who_had_the_item(api):
    photo = descriptor(jpeg_bytes())
    [r] = await api.push(
        "aditi", return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh"), "NEEDS_REPAIR", [photo], "TEAR")
    )
    assert r["status"] == "ACCEPTED"
    rep = next(x for x in (await api.get("ananya", "/v1/repairs")).json()["items"] if x["item"]["tag"] == "JKT-015")
    assert rep["issued_to"] == {"trekker_name": "Vikram Singh", "batch_code": "BRT-1012"}


async def test_membership_update_detects_concurrent_edit(api):
    users = (await api.get("kabir", "/v1/users")).json()["items"]
    aditi = next(u for u in users if u["display_name"] == "Aditi Rao")
    body = {"user_id": aditi["id"], "camp_id": str(sid("camp:SNK")), "enabled": True}
    first = await api.cmd("kabir", "MEMBERSHIP_UPDATE", None, body, expected_version=aditi["version"])
    assert first["status"] == "ACCEPTED"
    second = await api.cmd(
        "kabir", "MEMBERSHIP_UPDATE", None, {**body, "enabled": False}, expected_version=aditi["version"]
    )
    assert second["code"] == "VERSION_CONFLICT"


async def test_issue_helper_still_works(api):
    [r] = await api.push("aditi", issue_op("JKT-018"))
    assert r["status"] == "ACCEPTED"
