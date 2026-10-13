"""RET-01..02, REPAIR-01, PHOTO-01..02 and the repair lifecycle."""

import uuid

from conftest import descriptor, jpeg_bytes, return_op, sid

ALLOC_15 = sid("alloc:JKT-015:Vikram Singh")


async def _upload(api, user, att_id, data, *, complete=True):
    init = (await api.c.post(f"/v1/attachments/{att_id}/initiate", headers=api.headers(user))).json()
    url = init["upload_url"].replace("http://localhost:8000", "")
    r = await api.c.put(url, content=data, headers={"Content-Type": init["headers"]["Content-Type"]})
    assert r.status_code == 200, r.text
    if complete:
        return (await api.c.post(f"/v1/attachments/{att_id}/complete", headers=api.headers(user))).json()


async def _damaged_return(api, data=None):
    data = data or jpeg_bytes()
    photo = descriptor(data)
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "NEEDS_REPAIR", [photo], "BROKEN_ZIP"))
    assert r["status"] == "ACCEPTED", r
    return r, photo, data


async def test_ret01_pending_photo_keeps_item_blocked(api):
    r, photo, _ = await _damaged_return(api)
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}")).json()
    assert item["status"] == "REPAIR_PENDING"
    assert item["last_inspection"]["evidence_state"] == "PENDING"
    repair_id = r["data"]["repair_id"]
    res = await api.cmd("ananya", "APPROVE_REPAIR", repair_id, {"decision": "APPROVE"})
    assert res["status"] == "CONFLICT" and res["code"] == "EVIDENCE_PENDING"
    rel = await api.cmd(
        "ananya",
        "RELEASE_EQUIPMENT",
        sid("item:JKT-015"),
        {"inspection_id": str(uuid.uuid4()), "result": "PASS"},
    )
    assert rel["code"] == "REPAIR_NOT_APPROVED"


async def test_needs_repair_requires_photo(api):
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "NEEDS_REPAIR", None, "BROKEN_ZIP"))
    assert r["status"] == "REJECTED" and r["code"] == "INVALID_ANSWERS"
    assert r["field_errors"]["photos"] == "required"


async def test_ret02_wrong_or_closed_allocation(api):
    [r] = await api.push("aditi", return_op("JKT-015", sid("alloc:JKT-017:Rahul Mehta")))
    assert r["status"] == "REJECTED" and r["code"] == "ALLOCATION_MISMATCH"
    other = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-017')}")).json()
    assert other["status"] == "ISSUED"
    # JKT-016's allocation was already returned in the seed.
    [r] = await api.push("aditi", return_op("JKT-016", sid("alloc:JKT-016:Meera Iyer")))
    assert r["status"] == "CONFLICT" and r["code"] == "ALLOCATION_NOT_ACTIVE"


async def test_repeated_return_creates_one_inspection(api):
    op = return_op("JKT-015", ALLOC_15)
    [a] = await api.push("aditi", op)
    [b] = await api.push("aditi", op)
    assert a["status"] == "ACCEPTED" and b["replayed"]
    hist = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}/history")).json()["items"]
    assert sum(1 for e in hist if e["aggregate_type"] == "inspection" and e["event_type"] == "SUBMITTED") == 1


async def test_full_repair_lifecycle_and_repair01(api):
    r, photo, data = await _damaged_return(api)
    done = await _upload(api, "aditi", photo["attachment_id"], data)
    assert done["state"] == "VERIFIED" and done["inspection_evidence_state"] == "VERIFIED"
    repair_id = r["data"]["repair_id"]
    item_id = sid("item:JKT-015")

    approved = await api.cmd(
        "ananya", "APPROVE_REPAIR", repair_id, {"decision": "APPROVE", "note": "Replace zip"}
    )
    assert approved["status"] == "ACCEPTED" and approved["data"]["item_status"] == "UNDER_REPAIR"
    # Concurrent duplicate approval does not duplicate work.
    dup = await api.cmd("ananya", "APPROVE_REPAIR", repair_id, {"decision": "APPROVE"})
    assert dup["code"] == "REPAIR_ALREADY_DECIDED"
    # REPAIR-01: incomplete work cannot be released.
    early = await api.cmd(
        "ananya", "RELEASE_EQUIPMENT", item_id, {"inspection_id": str(uuid.uuid4()), "result": "PASS"}
    )
    assert early["status"] == "CONFLICT" and early["code"] == "REPAIR_INCOMPLETE"
    assert (await api.cmd("ananya", "START_REPAIR", repair_id, {}))["status"] == "ACCEPTED"
    assert (await api.cmd("ananya", "COMPLETE_REPAIR", repair_id, {"work_notes": "New YKK zip"}))[
        "status"
    ] == "ACCEPTED"
    # Item cannot be issued while under repair.
    from conftest import issue_op

    [iss] = await api.push("aditi", issue_op("JKT-015"))
    assert iss["status"] == "CONFLICT"
    # The rejected local claim raises a custody hold; release is blocked until it is reconciled.
    held = await api.cmd(
        "ananya", "RELEASE_EQUIPMENT", item_id, {"inspection_id": str(uuid.uuid4()), "result": "PASS"}
    )
    assert held["code"] == "CUSTODY_HOLD"
    conflict = (await api.get("ananya", "/v1/conflicts")).json()["conflicts"][0]
    cancel = await api.cmd(
        "aditi",
        "RESOLVE_ALLOCATION_CONFLICT",
        conflict["id"],
        {"resolution": "CANCEL_LOCAL_CLAIM", "note": "Jacket never left the bench"},
    )
    assert cancel["status"] == "ACCEPTED"
    rel = await api.cmd(
        "ananya",
        "RELEASE_EQUIPMENT",
        item_id,
        {"inspection_id": str(uuid.uuid4()), "result": "PASS", "notes": "Zip works"},
    )
    assert rel["status"] == "ACCEPTED", rel
    item = (await api.get("aditi", f"/v1/equipment/{item_id}")).json()
    assert item["status"] == "READY" and item["repair"]["state"] == "CLOSED"
    dl = await api.get("ananya", f"/v1/attachments/{photo['attachment_id']}/download")
    assert dl.status_code == 200
    content = await api.c.get(dl.json()["url"].replace("http://localhost:8000", ""))
    assert content.status_code == 200 and content.content[:3] == b"\xff\xd8\xff"


async def test_more_information_and_denial_never_makes_ready(api):
    r, photo, data = await _damaged_return(api)
    await _upload(api, "aditi", photo["attachment_id"], data)
    rid = r["data"]["repair_id"]
    more = await api.cmd(
        "ananya", "APPROVE_REPAIR", rid, {"decision": "MORE_INFORMATION", "note": "Photo of tag"}
    )
    assert more["data"]["state"] == "MORE_INFORMATION_REQUIRED"
    deny = await api.cmd("ananya", "APPROVE_REPAIR", rid, {"decision": "DENY"})
    assert deny["code"] == "DISPOSITION_REQUIRED"
    deny = await api.cmd(
        "ananya",
        "APPROVE_REPAIR",
        rid,
        {"decision": "DENY", "disposition": "QUARANTINE", "note": "Not worth fixing yet"},
    )
    assert deny["data"]["item_status"] == "QUARANTINED"


async def test_good_return_requires_supervisor_release(api):
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "GOOD"))
    assert r["status"] == "ACCEPTED"
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}")).json()
    assert item["status"] == "QUARANTINED"
    nope = await api.cmd(
        "aditi",
        "RELEASE_EQUIPMENT",
        sid("item:JKT-015"),
        {"inspection_id": str(uuid.uuid4()), "result": "PASS"},
    )
    assert nope["code"] == "FORBIDDEN"
    ok = await api.cmd(
        "ananya",
        "RELEASE_EQUIPMENT",
        sid("item:JKT-015"),
        {"inspection_id": str(uuid.uuid4()), "result": "PASS"},
    )
    assert ok["data"]["status"] == "READY"


async def test_unusable_needs_supervisor_retirement(api):
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "UNUSABLE", issue_type="TEAR"))
    assert r["status"] == "ACCEPTED"
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}")).json()
    assert item["status"] == "QUARANTINED"  # never auto-retired from a radio button
    rel = await api.cmd(
        "ananya",
        "RELEASE_EQUIPMENT",
        sid("item:JKT-015"),
        {"inspection_id": str(uuid.uuid4()), "result": "PASS"},
    )
    assert rel["code"] == "DISPOSITION_PENDING"
    res = await api.cmd("ananya", "APPROVE_REPAIR", r["data"]["repair_id"], {"decision": "APPROVE"})
    assert res["data"]["item_status"] == "RETIRED"
    hist = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}/history")).json()
    assert hist["items"][0]["event_type"].startswith("DECISION")


async def test_photo01_spoofed_truncated_oversized_rejected(api):
    real = jpeg_bytes()
    r, photo, _ = await _damaged_return(api, real)
    # Upload different bytes than declared: hash mismatch.
    spoof = b"\x89PNG\r\n\x1a\n" + b"0" * (len(real) - 8)
    res = await _upload(api, "aditi", photo["attachment_id"], spoof)
    assert res["state"] == "REJECTED" and res["reason"] in ("HASH_MISMATCH", "SIZE_MISMATCH")
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}")).json()
    assert item["last_inspection"]["evidence_state"] == "REJECTED"
    res = await api.cmd("ananya", "APPROVE_REPAIR", r["data"]["repair_id"], {"decision": "APPROVE"})
    assert res["code"] == "EVIDENCE_PENDING"


async def test_photo_declared_hash_matches_but_not_an_image(api):
    junk = b"\xff\xd8\xff" + b"not really a jpeg" * 10
    photo = descriptor(junk)
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "NEEDS_REPAIR", [photo], "TEAR"))
    res = await _upload(api, "aditi", photo["attachment_id"], junk)
    assert res["state"] == "REJECTED" and res["reason"] == "UNDECODABLE"


async def test_photo_oversized_declaration_rejected(api):
    photo = descriptor(jpeg_bytes())
    photo["bytes"] = 50 * 1024 * 1024
    [r] = await api.push("aditi", return_op("JKT-015", ALLOC_15, "NEEDS_REPAIR", [photo], "TEAR"))
    assert r["status"] == "REJECTED" and r["code"] == "PHOTO_TOO_LARGE"


async def test_photo02_complete_is_idempotent_and_owner_only(api):
    r, photo, data = await _damaged_return(api)
    forbidden = await api.c.post(
        f"/v1/attachments/{photo['attachment_id']}/initiate", headers=api.headers("ramesh")
    )
    assert forbidden.status_code == 403
    not_yet = await api.c.post(
        f"/v1/attachments/{photo['attachment_id']}/complete", headers=api.headers("aditi")
    )
    assert not_yet.status_code == 409 and not_yet.json()["error"]["retryable"] is True
    first = await _upload(api, "aditi", photo["attachment_id"], data)
    again = (
        await api.c.post(f"/v1/attachments/{photo['attachment_id']}/complete", headers=api.headers("aditi"))
    ).json()
    assert first["state"] == again["state"] == "VERIFIED"


async def test_upload_slot_token_cannot_be_forged(api):
    r, photo, data = await _damaged_return(api)
    bad = await api.c.put(f"/v1/attachments/{photo['attachment_id']}/content?token=abc", content=data)
    assert bad.status_code == 403


async def test_evidence_orientation_applied_and_exif_stripped(api):
    import io

    from PIL import Image

    img = Image.new("RGB", (80, 40), (10, 200, 10))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    exif[0x8825] = {2: (28.0, 0.0, 0.0)}  # GPS block that must be removed
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    data = buf.getvalue()
    r, photo, _ = await _damaged_return(api, data)
    done = await _upload(api, "aditi", photo["attachment_id"], data)
    assert done["state"] == "VERIFIED"
    dl = (await api.get("ananya", f"/v1/attachments/{photo['attachment_id']}/download")).json()
    stored = (await api.c.get(dl["url"].replace("http://localhost:8000", ""))).content
    out = Image.open(io.BytesIO(stored))
    assert out.size == (40, 80)  # upright
    assert not out.getexif()
