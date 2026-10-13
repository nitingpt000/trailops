"""AUTH-01..04, EQ-01: token validation, permissions and camp scope."""

import uuid

import jwt
from conftest import KID, issue_op, make_token, sid
from cryptography.hazmat.primitives.asymmetric import rsa


async def test_auth01_bad_audience_issuer_signature_rejected(api):
    subject = str(sid("user:aditi"))
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    for token in (
        make_token(subject, aud="someone-else"),
        make_token(subject, iss="https://evil.example/realms/x"),
        make_token(subject, key=other),
        make_token(subject, exp_in=-120),
        make_token(subject, typ="ID"),
    ):
        r = await api.c.get("/v1/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401, r.text
        assert r.json()["error"]["code"] in ("INVALID_TOKEN", "TOKEN_EXPIRED")
    hs = jwt.encode({"sub": subject}, "secret", algorithm="HS256", headers={"kid": KID})
    r = await api.c.get("/v1/me", headers={"Authorization": f"Bearer {hs}"})
    assert r.status_code == 401
    assert (await api.c.get("/v1/me")).status_code == 401


async def test_me_reports_scope(api):
    r = await api.get("aditi", "/v1/me")
    body = r.json()
    assert body["role"] == "camp_operator"
    assert [c["code"] for c in body["camps"]] == ["LHJ"]
    assert "repair.approve" not in body["permissions"]


async def test_auth02_operator_cannot_approve_repair(api):
    # Find the open repair created by a damaged return.
    from conftest import descriptor, jpeg_bytes, return_op

    photo = descriptor(jpeg_bytes())
    [r] = await api.push(
        "aditi",
        return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh"), "NEEDS_REPAIR", [photo], "BROKEN_ZIP"),
    )
    assert r["status"] == "ACCEPTED", r
    repair_id = r["data"]["repair_id"]
    res = await api.cmd("aditi", "APPROVE_REPAIR", repair_id, {"decision": "APPROVE"})
    assert res["status"] == "REJECTED" and res["code"] == "FORBIDDEN"
    # And not via the offline queue either.
    [q] = await api.push(
        "aditi",
        {
            "operation_id": str(uuid.uuid4()),
            "type": "APPROVE_REPAIR",
            "aggregate_id": repair_id,
            "payload": {"decision": "APPROVE"},
        },
    )
    assert q["status"] == "REJECTED"


async def test_auth03_cross_camp_access_denied(api):
    sankri_item = sid("item:JKT-023")  # at Sankri; Aditi is Lohajung-only
    assert (await api.get("aditi", f"/v1/equipment/{sankri_item}")).status_code == 404
    assert (await api.get("aditi", "/v1/equipment/by-tag/JKT-023")).status_code == 404
    assert (await api.get("aditi", f"/v1/batches/{sid('batch:KDK-1014')}/members")).status_code == 404
    r = await api.get("aditi", "/v1/equipment", camp_id=str(sid("camp:SNK")))
    assert r.status_code == 404
    # Issuing a Lohajung item to a Sankri batch is refused server-side.
    [res] = await api.push("aditi", issue_op("JKT-018", trekker="Aman Verma", batch="KDK-1014"))
    assert res["status"] == "REJECTED" and res["code"] == "UNKNOWN_BATCH"
    # Sankri item cannot be issued by a Lohajung operator.
    [res] = await api.push("aditi", issue_op("JKT-023"))
    assert res["status"] == "REJECTED" and res["code"] == "FORBIDDEN"


async def test_auth04_revoked_membership_rejected_on_reconnect(api):
    await api.device("aditi")
    res = await api.cmd(
        "kabir",
        "MEMBERSHIP_UPDATE",
        None,
        {"user_id": str(sid("user:aditi")), "camp_id": str(sid("camp:LHJ")), "enabled": False},
    )
    assert res["status"] == "ACCEPTED", res
    [r] = await api.push("aditi", issue_op("JKT-018"))
    assert r["status"] == "REJECTED" and r["code"] == "FORBIDDEN"
    assert (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-018')}")).status_code == 404


async def test_eq01_duplicate_tag_rejected(api):
    payload = {
        "category_id": str(sid("cat:JKT")),
        "tag": "JKT-014",
        "location_id": str(sid("loc:Lohajung Store")),
    }
    res = await api.cmd("ananya", "EQUIPMENT_CREATE", uuid.uuid4(), payload)
    assert res["status"] == "REJECTED" and res["code"] == "DUPLICATE_TAG"
    res = await api.cmd("ananya", "EQUIPMENT_CREATE", uuid.uuid4(), {**payload, "tag": "jkt-099"})
    assert res["status"] == "ACCEPTED", res
    res = await api.cmd("aditi", "EQUIPMENT_CREATE", uuid.uuid4(), {**payload, "tag": "JKT-100"})
    assert res["code"] == "FORBIDDEN"


async def test_equipment_update_cannot_patch_status_and_detects_stale_version(api):
    item = sid("item:JKT-018")
    res = await api.cmd("ananya", "EQUIPMENT_UPDATE", item, {"status": "READY"}, expected_version=1)
    assert res["status"] == "REJECTED" and res["code"] == "INVALID_INPUT"
    ok = await api.cmd("ananya", "EQUIPMENT_UPDATE", item, {"notes": "New zip pull"}, expected_version=1)
    assert ok["status"] == "ACCEPTED"
    stale = await api.cmd("ananya", "EQUIPMENT_UPDATE", item, {"notes": "Old view"}, expected_version=1)
    assert stale["status"] == "CONFLICT" and stale["code"] == "VERSION_CONFLICT"


async def test_device_heartbeat_reports_zero_pending(api):
    dev = await api.device("aditi")
    r = await api.c.post("/v1/sync/commands", headers=api.headers("aditi", True), json={
        "protocol_version": 1, "device_id": dev, "pending_count": 3,
        "operations": [{"operation_id": str(uuid.uuid4()), "type": "ISSUE_GEAR",
                        "aggregate_id": str(sid("item:JKT-018")), "payload": {}}]})
    assert r.status_code == 200
    devices = (await api.get("ananya", "/v1/devices")).json()["items"]
    assert next(d for d in devices if d["id"] == dev)["reported_pending"] == 3
    hb = await api.c.post("/v1/devices/heartbeat", headers=api.headers("aditi", True), json={"pending_count": 0})
    assert hb.status_code == 200
    devices = (await api.get("ananya", "/v1/devices")).json()["items"]
    assert next(d for d in devices if d["id"] == dev)["reported_pending"] == 0
    no_device = await api.c.post("/v1/devices/heartbeat", headers=api.headers("aditi"), json={"pending_count": 0})
    assert no_device.status_code == 422
