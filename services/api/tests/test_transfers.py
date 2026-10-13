"""TR-01..03: dispatch atomicity, partial receipt, dependency wait."""

import uuid

from conftest import issue_op, sid

LHJ = str(sid("loc:Lohajung Store"))
SNK = str(sid("loc:Sankri Store"))
FIVE = ["JKT-018", "JKT-020", "SHO-007", "SHO-009", "SBG-007"]  # all at Lohajung Store


def dispatch(items, op_id=None, transfer_id=None):
    return {
        "operation_id": str(op_id or uuid.uuid4()),
        "type": "DISPATCH_TRANSFER",
        "aggregate_id": str(transfer_id or uuid.uuid4()),
        "payload": {
            "from_location_id": LHJ,
            "to_location_id": SNK,
            "item_ids": [str(sid(f"item:{t}")) for t in items],
            "note": "Jeep",
        },
    }


async def test_tr01_one_invalid_item_fails_whole_dispatch(api):
    await api.push("aditi", issue_op("SHO-007"))
    [r] = await api.push("aditi", dispatch(FIVE))
    assert r["status"] == "CONFLICT" and r["code"] == "TRANSFER_ITEM_UNAVAILABLE"
    assert [x["tag"] for x in r["details"]["items"]] == ["SHO-007"]
    for tag in ("JKT-018", "SBG-007"):
        assert (await api.get("aditi", f"/v1/equipment/{sid(f'item:{tag}')}")).json()["status"] == "READY"


async def test_dispatch_validation(api):
    op = dispatch(["JKT-018", "JKT-018"])
    [r] = await api.push("aditi", op)
    assert r["code"] == "DUPLICATE_ITEMS"
    op = dispatch(["JKT-018"])
    op["payload"]["to_location_id"] = LHJ
    [r] = await api.push("aditi", op)
    assert r["code"] == "SAME_LOCATION"


async def test_tr02_five_dispatched_four_received(api):
    tid = uuid.uuid4()
    [r] = await api.push("aditi", dispatch(FIVE, transfer_id=tid))
    assert r["status"] == "ACCEPTED", r
    lines = [{"item_id": str(sid(f"item:{t}")), "result": "RECEIVED"} for t in FIVE[:4]]
    lines.append({"item_id": str(sid(f"item:{FIVE[4]}")), "result": "MISSING", "note": "Not in the jeep"})
    rec = await api.cmd("ananya", "RECEIVE_TRANSFER", tid, {"lines": lines})
    assert rec["status"] == "ACCEPTED" and rec["data"]["state"] == "DISCREPANCY", rec
    got = (await api.get("ananya", f"/v1/equipment/{sid('item:JKT-018')}")).json()
    assert got["status"] == "QUARANTINED" and got["location"]["label"] == "Sankri Store"
    missing = (await api.get("ananya", f"/v1/equipment/{sid('item:SBG-007')}")).json()
    assert missing["status"] == "MISSING" and missing["location"]["label"] == "Lohajung Store"
    # Missing asset cannot be issued.
    [iss] = await api.push("aditi", issue_op("SBG-007"))
    assert iss["status"] == "CONFLICT"
    # Double receipt with a new operation is refused; replay of the same op is idempotent.
    again = await api.cmd("ananya", "RECEIVE_TRANSFER", tid, {"lines": lines})
    assert again["code"] == "TRANSFER_ALREADY_RECEIVED"
    # Supervisor finds the bag; it comes back quarantined, not READY.
    tr = next(t for t in (await api.get("ananya", "/v1/transfers")).json()["items"] if t["id"] == str(tid))
    line = next(x for x in tr["lines"] if x["receipt_state"] == "MISSING")
    fix = await api.cmd(
        "ananya",
        "RESOLVE_TRANSFER_DISCREPANCY",
        line["id"],
        {"finding": "FOUND", "reason": "Found under jeep seat"},
    )
    assert fix["code"] == "INVALID_INPUT"
    fix = await api.cmd(
        "ananya",
        "RESOLVE_TRANSFER_DISCREPANCY",
        line["id"],
        {"finding": "FOUND", "location_id": SNK, "reason": "Found under jeep seat"},
    )
    assert fix["status"] == "ACCEPTED" and fix["data"]["transfer_state"] == "RECONCILED"
    assert fix["data"]["item_status"] == "QUARANTINED"


async def test_receipt_must_cover_manifest_and_destination_permission(api):
    tid = uuid.uuid4()
    await api.push("aditi", dispatch(FIVE, transfer_id=tid))
    partial = await api.cmd(
        "ananya",
        "RECEIVE_TRANSFER",
        tid,
        {"lines": [{"item_id": str(sid("item:JKT-018")), "result": "RECEIVED"}]},
    )
    assert partial["code"] == "RECEIPT_MISMATCH"
    lines = [{"item_id": str(sid(f"item:{t}")), "result": "RECEIVED"} for t in FIVE]
    # Aditi (Lohajung only) cannot receive into Sankri.
    nope = await api.cmd("aditi", "RECEIVE_TRANSFER", tid, {"lines": lines})
    assert nope["code"] == "FORBIDDEN"


async def test_tr03_offline_receipt_before_dispatch_waits_then_succeeds(api):
    tid = uuid.uuid4()
    dispatch_op_id = uuid.uuid4()
    lines = [{"item_id": str(sid(f"item:{t}")), "result": "RECEIVED"} for t in FIVE]
    receive = {
        "operation_id": str(uuid.uuid4()),
        "type": "RECEIVE_TRANSFER",
        "aggregate_id": str(tid),
        "depends_on": [str(dispatch_op_id)],
        "payload": {"lines": lines},
    }
    [first] = await api.push("ananya", receive)
    assert first["status"] == "DEPENDENCY_PENDING" and first["retryable"]
    [d] = await api.push("aditi", dispatch(FIVE, op_id=dispatch_op_id, transfer_id=tid))
    assert d["status"] == "ACCEPTED"
    [second] = await api.push("ananya", receive)
    assert second["status"] == "ACCEPTED" and second["data"]["state"] == "RECEIVED"


async def test_extra_item_creates_custody_claim(api):
    tid = uuid.uuid4()
    await api.push("aditi", dispatch(["JKT-018"], transfer_id=tid))
    rec = await api.cmd(
        "ananya",
        "RECEIVE_TRANSFER",
        tid,
        {
            "lines": [{"item_id": str(sid("item:JKT-018")), "result": "RECEIVED"}],
            "extra_items": [{"tag": "BPK-016", "note": "Was in the sack"}],
        },
    )
    assert rec["data"]["state"] == "DISCREPANCY"
    claims = (await api.get("ananya", "/v1/conflicts")).json()["custody_claims"]
    claim = next(c for c in claims if c["source_type"] == "TRANSFER_EXTRA")
    # The extra item is blocked from issue until reconciled.
    [iss] = await api.push("ananya", issue_op("BPK-016", trekker="Aman Verma", batch="KDK-1014"))
    assert iss["code"] == "CUSTODY_HOLD"
    res = await api.cmd(
        "ananya", "RESOLVE_CUSTODY_CLAIM", claim["id"], {"location_id": SNK, "note": "Checked tag"}
    )
    assert res["status"] == "ACCEPTED"
