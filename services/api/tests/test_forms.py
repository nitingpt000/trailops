"""FORM-01..03 plus shared fixture conformance (the TS engine runs the same fixtures)."""

import copy
import json
import uuid
from pathlib import Path

import pytest
from conftest import return_op, sid

from app.modules.forms.engine import schema_hash, validate_answers, validate_schema

FIX = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures" / "forms"
SCHEMA_CASES = json.loads((FIX / "schema-cases.json").read_text())
ANSWER_CASES = json.loads((FIX / "answer-cases.json").read_text())


def apply_patch(base: dict, patch: dict | None) -> dict:
    doc = copy.deepcopy(base)
    for path, value in (patch or {}).items():
        parts = path.split(".")
        target = doc
        for p in parts[:-1]:
            target = target[int(p)] if isinstance(target, list) else target[p]
        last = parts[-1]
        if isinstance(target, list):
            if value is None:
                target.pop(int(last))
            else:
                target[int(last)] = value
        else:
            target[last] = value
    return doc


@pytest.mark.parametrize("case", SCHEMA_CASES["cases"], ids=lambda c: c["name"])
def test_schema_fixture(case):
    errors = validate_schema(apply_patch(SCHEMA_CASES["base"], case["patch"]))
    assert sorted(errors) == sorted(case["errors"]), errors


@pytest.mark.parametrize("case", ANSWER_CASES["cases"], ids=lambda c: c["name"])
def test_answer_fixture(case):
    answers = {k: ("x" * 501 if v == "@@LONG@@" else v) for k, v in case["answers"].items()}
    errors = validate_answers(SCHEMA_CASES["base"], answers, attachment_ids=set(case["attachments"]))
    assert sorted(errors) == sorted(case["errors"]), errors


async def _return_form(api):
    return next(
        f for f in (await api.get("kabir", "/v1/forms")).json()["items"] if f["key"] == "return-inspection"
    )


async def _publish_v4(api):
    form = await _return_form(api)
    v3 = next(v for v in form["versions"] if v["number"] == 3)
    schema = {
        **v3["schema"],
        "fields": [*v3["schema"]["fields"], {"id": "smell", "type": "boolean", "label": "Needs washing"}],
    }
    saved = await api.cmd("ananya", "FORM_DRAFT_SAVE", form["id"], {"schema": schema})
    assert saved["status"] == "ACCEPTED", saved
    pub = await api.cmd(
        "kabir",
        "FORM_PUBLISH",
        saved["data"]["form_version_id"],
        {"expected_hash": saved["data"]["schema_hash"]},
    )
    return saved, pub


async def test_form01_v4_publish_keeps_v3_drafts_and_submissions(api):
    [submitted] = await api.push("aditi", return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh")))
    assert submitted["status"] == "ACCEPTED"
    saved, pub = await _publish_v4(api)
    assert pub["status"] == "ACCEPTED" and pub["data"]["number"] == 4, pub
    # An old offline v3 draft still submits against v3 (grace policy).
    [late] = await api.push("aditi", return_op("JKT-017", sid("alloc:JKT-017:Rahul Mehta"), form_version=3))
    assert late["status"] == "ACCEPTED", late
    item = (await api.get("aditi", f"/v1/equipment/{sid('item:JKT-015')}")).json()
    assert item["last_inspection"]["form_version_id"] == str(sid("form:return-inspection:v3"))
    form = await _return_form(api)
    v3 = next(v for v in form["versions"] if v["number"] == 3)
    assert v3["schema_hash"] == schema_hash(v3["schema"])
    assert form["active_version_id"] == saved["data"]["form_version_id"]
    again = await api.cmd(
        "kabir",
        "FORM_PUBLISH",
        saved["data"]["form_version_id"],
        {"expected_hash": saved["data"]["schema_hash"]},
    )
    assert again["code"] == "ALREADY_PUBLISHED"


async def test_form02_malicious_rules_rejected_at_publication(api):
    form = await _return_form(api)
    bad = {
        "schema_version": 1,
        "key": "return-inspection",
        "fields": [
            {
                "id": "condition",
                "type": "select",
                "required": True,
                "options": ["GOOD", "NEEDS_REPAIR", "UNUSABLE"],
            },
            {
                "id": "x",
                "type": "text",
                "visible_when": {"field": "condition", "operator": "eval", "value": "1"},
            },
        ],
    }
    saved = await api.cmd("ananya", "FORM_DRAFT_SAVE", form["id"], {"schema": bad})
    assert saved["data"]["validation_errors"]
    pub = await api.cmd(
        "kabir",
        "FORM_PUBLISH",
        saved["data"]["form_version_id"],
        {"expected_hash": saved["data"]["schema_hash"]},
    )
    assert pub["status"] == "REJECTED" and pub["code"] == "INVALID_SCHEMA"


async def test_form_publish_requires_permission_and_fresh_hash(api):
    await _publish_v4(api)
    form = await _return_form(api)
    v4 = next(v for v in form["versions"] if v["number"] == 4)
    s2 = await api.cmd("ananya", "FORM_DRAFT_SAVE", form["id"], {"schema": v4["schema"]})
    assert s2["data"]["number"] == 5
    denied = await api.cmd(
        "ananya", "FORM_PUBLISH", s2["data"]["form_version_id"], {"expected_hash": s2["data"]["schema_hash"]}
    )
    assert denied["code"] == "FORBIDDEN"
    stale = await api.cmd("kabir", "FORM_PUBLISH", s2["data"]["form_version_id"], {"expected_hash": "0" * 64})
    assert stale["code"] == "VERSION_CONFLICT"


async def test_form03_hidden_and_unknown_answers_rejected_by_server(api):
    op = return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh"), "GOOD")
    op["payload"]["answers"]["issue_type"] = "TEAR"
    [r] = await api.push("aditi", op)
    assert r["status"] == "REJECTED" and r["field_errors"]["issue_type"]
    op = return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh"))
    op["payload"]["answers"]["__proto__"] = 1
    [r] = await api.push("aditi", op)
    assert r["status"] == "REJECTED" and "__proto__" in r["field_errors"]


async def test_retired_form_version_returns_unsupported(api):
    [r] = await api.push("aditi", return_op("JKT-015", sid("alloc:JKT-015:Vikram Singh"), form_version=2))
    assert r["status"] == "REJECTED" and r["code"] == "FORM_VERSION_UNSUPPORTED"


async def test_drafts_never_reach_devices(api):
    await api.device("aditi")
    form = await _return_form(api)
    await api.cmd("ananya", "FORM_DRAFT_SAVE", form["id"], {"schema": {"schema_version": 1, "fields": []}})
    boot = (await api.c.post("/v1/sync/bootstrap", headers=api.headers("aditi", True))).json()
    assert {v["status"] for v in boot["records"]["form_version"]} <= {"PUBLISHED", "RETIRED"}
    assert uuid.UUID(boot["records"]["form_definition"][0]["active_version_id"])
