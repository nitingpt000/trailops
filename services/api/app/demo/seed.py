"""Demo seed: one organization, two camps, 20 fictional trekkers, 50 tagged assets, four users.

Safe only for demo environments: `--reset` truncates every TrailOps table. All people are fictional.
Reference data is emitted through DomainTx so the sync change stream and scopes are consistent, and
the initial issues/returns go through the real command processor so they carry audit history.

    uv run python -m app.demo.seed --reset
"""

import argparse
import asyncio
import uuid
from datetime import date, timedelta

from sqlalchemy import text

from app.core.auth import Principal
from app.core.db import sessionmaker
from app.core.permissions import ROLE_PERMISSIONS
from app.core.tx import DomainTx
from app.models import (
    BatchMember,
    Camp,
    CampMembership,
    EquipmentCategory,
    EquipmentItem,
    FormDefinition,
    FormVersion,
    Location,
    Membership,
    Organization,
    TrekBatch,
    Trekker,
    User,
)
from app.modules.commands.base import OperationIn
from app.modules.commands.processor import execute
from app.modules.forms.engine import schema_hash

NS = uuid.UUID("6f1c2a52-5b0e-4b7e-9a51-0d7a3c1f8e10")


def sid(name: str) -> uuid.UUID:
    return uuid.uuid5(NS, name)


ORG = sid("org")
CAMPS = {"LHJ": ("Lohajung base camp", "Asia/Kolkata"), "SNK": ("Sankri base camp", "Asia/Kolkata")}
LOCATIONS = [
    ("LHJ", "Lohajung Store", "STORE"),
    ("LHJ", "Rack B2", "RACK"),
    ("LHJ", "Repair bench", "REPAIR_BENCH"),
    ("SNK", "Sankri Store", "STORE"),
]
# Keycloak user ids are fixed in infra/keycloak/trailops-realm.json so `sub` matches.
USERS = [
    ("aditi", "Aditi Rao", "aditi@trailops.example", "camp_operator", False, ["LHJ"]),
    ("ramesh", "Ramesh Bisht", "ramesh@trailops.example", "trek_leader", False, ["LHJ"]),
    ("ananya", "Ananya Prakash", "ananya@trailops.example", "supervisor", False, ["LHJ", "SNK"]),
    ("kabir", "Kabir Sethi", "kabir@trailops.example", "administrator", True, []),
]
CATEGORIES = [
    ("JKT", "Padded jacket", "Clothing", "item", "padded-jacket"),
    ("POL", "Trekking poles", "Equipment", "pair", "trekking-poles"),
    ("SHO", "Trekking shoes", "Footwear", "pair", "trekking-shoes"),
    ("BPK", "Backpack (60L)", "Equipment", "item", "backpack"),
    ("SBG", "Sleeping bag (-10°C)", "Sleeping", "item", "sleeping-bag"),
]
SIZES = {
    "JKT": ["S", "M", "M", "L", "L", "XL"],
    "POL": ["120–135 cm"],
    "SHO": ["7", "8", "8", "9", "10"],
    "BPK": ["60L"],
    "SBG": ["Regular", "Long"],
}
TREKKERS = [
    "Vikram Singh",
    "Meera Iyer",
    "Rahul Mehta",
    "Sneha Patil",
    "Arjun Gupta",
    "Priya Nair",
    "Karan Malhotra",
    "Isha Kapoor",
    "Dev Joshi",
    "Ananya Bose",
    "Rohan Das",
    "Tara Menon",
    "Nikhil Rana",
    "Pooja Shah",
    "Aman Verma",
    "Neha Kulkarni",
    "Siddharth Rao",
    "Kavya Reddy",
    "Farhan Ali",
    "Ritu Chauhan",
]
TODAY = date(2026, 10, 13)
BATCHES = [
    (
        "BRT-1012",
        "Brahmatal Trek",
        "LHJ",
        TODAY - timedelta(days=1),
        TODAY + timedelta(days=5),
        TREKKERS[0:8],
    ),
    (
        "ALB-1015",
        "Ali Bedni Bugyal",
        "LHJ",
        TODAY + timedelta(days=2),
        TODAY + timedelta(days=7),
        TREKKERS[8:14],
    ),
    (
        "KDK-1014",
        "Kedarkantha Trek",
        "SNK",
        TODAY + timedelta(days=1),
        TODAY + timedelta(days=6),
        TREKKERS[14:20],
    ),
]

RETURN_FORM_V3 = {
    "schema_version": 1,
    "key": "return-inspection",
    "version": 3,
    "title": "Return inspection",
    "fields": [
        {"id": "equipment", "type": "equipment_ref", "label": "Equipment tag", "required": True},
        {
            "id": "condition",
            "type": "select",
            "label": "Condition",
            "required": True,
            "options": ["GOOD", "NEEDS_REPAIR", "UNUSABLE"],
            "option_labels": {"GOOD": "Good", "NEEDS_REPAIR": "Needs repair", "UNUSABLE": "Unusable"},
        },
        {
            "id": "issue_type",
            "type": "select",
            "label": "Issue type",
            "required": True,
            "options": ["BROKEN_ZIP", "TEAR", "SOLE_DAMAGE", "BROKEN_BUCKLE", "OTHER"],
            "option_labels": {
                "BROKEN_ZIP": "Zipper not working",
                "TEAR": "Tear in fabric",
                "SOLE_DAMAGE": "Sole damage",
                "BROKEN_BUCKLE": "Broken buckle",
                "OTHER": "Other",
            },
            "visible_when": {"field": "condition", "operator": "in", "value": ["NEEDS_REPAIR", "UNUSABLE"]},
        },
        {
            "id": "photos",
            "type": "photo",
            "label": "Photos",
            "max_count": 3,
            "required_when": {"field": "condition", "operator": "equals", "value": "NEEDS_REPAIR"},
        },
        {"id": "notes", "type": "textarea", "label": "Notes", "max_length": 500},
    ],
}

SYSTEM = Principal(
    user_id=sid("user:kabir"),
    display_name="Seed",
    org_id=ORG,
    role="administrator",
    permissions=frozenset().union(*ROLE_PERMISSIONS.values()),
    org_wide=True,
    camp_ids=frozenset(),
    scope_epoch=1,
    request_id="seed",
)


async def reset(session) -> None:
    tables = (
        "jobs, sync_sequences, entity_scopes, change_log, audit_events, conflicts, operations, attachments, "
        "custody_claims, transfer_lines, transfers, repairs, inspections, allocations, form_versions, "
        "form_definitions, equipment_items, equipment_categories, batch_members, trekkers, trek_batches, devices, "
        "locations, camp_memberships, camps, memberships, users, organizations"
    )
    await session.execute(text("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only"))
    await session.execute(text(f"TRUNCATE {tables} CASCADE"))
    await session.execute(text("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only"))


async def seed_reference(session) -> dict:
    ids: dict = {}
    session.add(Organization(id=ORG, name="TrailOps Demo Organisation"))
    await session.flush()
    for code, (name, tz) in CAMPS.items():
        session.add(Camp(id=sid(f"camp:{code}"), org_id=ORG, code=code, name=name, timezone=tz, version=1))
    for camp, label, typ in LOCATIONS:
        session.add(
            Location(
                id=sid(f"loc:{label}"),
                org_id=ORG,
                camp_id=sid(f"camp:{camp}"),
                label=label,
                type=typ,
                version=1,
            )
        )
    for key, name, email, role, org_wide, camps in USERS:
        uid = sid(f"user:{key}")
        session.add(User(id=uid, keycloak_subject=str(uid), display_name=name, email=email, enabled=True))
        await session.flush()
        session.add(
            Membership(
                org_id=ORG,
                user_id=uid,
                role=role,
                org_wide=org_wide,
                extra_permissions=[],
                scope_epoch=1,
                enabled=True,
            )
        )
        for c in camps:
            session.add(
                CampMembership(
                    org_id=ORG,
                    user_id=uid,
                    camp_id=sid(f"camp:{c}"),
                    permissions=[],
                    access_epoch=1,
                    enabled=True,
                )
            )
    for code, name, group, unit, image in CATEGORIES:
        session.add(
            EquipmentCategory(
                id=sid(f"cat:{code}"),
                org_id=ORG,
                code=code,
                name=name,
                group=group,
                unit=unit,
                inspect_on_return=True,
                image_key=image,
                version=1,
            )
        )
    await session.flush()
    # 50 assets: 8 per category at Lohajung, 2 per category at Sankri.
    n = 0
    for code, *_ in CATEGORIES:
        for i in range(10):
            n += 1
            tag = f"{code}-{(14 if code == 'JKT' else 7) + i:03d}"
            loc = "Sankri Store" if i >= 8 else ("Rack B2" if i % 2 else "Lohajung Store")
            session.add(
                EquipmentItem(
                    id=sid(f"item:{tag}"),
                    org_id=ORG,
                    tag=tag,
                    category_id=sid(f"cat:{code}"),
                    size=SIZES[code][i % len(SIZES[code])],
                    status="READY",
                    location_id=sid(f"loc:{loc}"),
                    version=1,
                )
            )
    for idx, name in enumerate(TREKKERS):
        session.add(
            Trekker(
                id=sid(f"trekker:{name}"),
                org_id=ORG,
                display_name=name,
                size_hint=["S", "M", "L", "XL"][idx % 4],
                active=True,
            )
        )
    await session.flush()
    for code, trek, camp, start, end, members in BATCHES:
        session.add(
            TrekBatch(
                id=sid(f"batch:{code}"),
                org_id=ORG,
                code=code,
                trek_name=trek,
                camp_id=sid(f"camp:{camp}"),
                start_date=start,
                end_date=end,
                active=True,
                version=1,
            )
        )
        await session.flush()
        for m in members:
            session.add(
                BatchMember(
                    id=sid(f"bm:{code}:{m}"),
                    org_id=ORG,
                    batch_id=sid(f"batch:{code}"),
                    trekker_id=sid(f"trekker:{m}"),
                    gear_requested=["JKT", "POL", "SBG"],
                )
            )
    fd = FormDefinition(
        id=sid("form:return-inspection"),
        org_id=ORG,
        key="return-inspection",
        title="Return inspection",
        version=1,
    )
    session.add(fd)
    await session.flush()
    v2 = dict(
        RETURN_FORM_V3, version=2, fields=[f for f in RETURN_FORM_V3["fields"] if f["id"] != "issue_type"]
    )
    for num, schema, status in ((2, v2, "RETIRED"), (3, RETURN_FORM_V3, "PUBLISHED")):
        from datetime import UTC, datetime

        session.add(
            FormVersion(
                id=sid(f"form:return-inspection:v{num}"),
                org_id=ORG,
                definition_id=fd.id,
                number=num,
                status=status,
                schema=schema,
                schema_hash=schema_hash(schema),
                published_at=datetime(2026, 9, 1, tzinfo=UTC),
                version=1,
            )
        )
    fd.active_version_id = sid("form:return-inspection:v3")
    await session.flush()
    return ids


async def emit_reference(session) -> None:
    from sqlalchemy import select

    tx = DomainTx(session, SYSTEM, command_type="SEED")
    await tx.lock_gate()
    for entity, model in (
        ("camp", Camp),
        ("location", Location),
        ("category", EquipmentCategory),
        ("form_definition", FormDefinition),
        ("form_version", FormVersion),
        ("batch", TrekBatch),
        ("batch_member", BatchMember),
        ("equipment", EquipmentItem),
    ):
        for obj in (await session.execute(select(model).where(model.org_id == ORG))).scalars():
            await tx.emit(entity, obj)
            if entity == "equipment":
                await tx.audit(
                    "equipment",
                    obj.id,
                    "CREATED",
                    after={"tag": obj.tag},
                    version=1,
                    camp_id=await tx.proj.location_camp(obj.location_id),
                    summary="Added to inventory",
                )
    await tx.finish()


async def run_command(session, actor: str, type_: str, aggregate: uuid.UUID, payload: dict, key: str) -> dict:
    from app.core.auth import resolve_principal

    principal = await resolve_principal(session, str(sid(f"user:{actor}")), None)
    await session.rollback()
    op = OperationIn(operation_id=sid(f"op:{key}"), type=type_, aggregate_id=aggregate, payload=payload)
    r = await execute(session, principal, op, online=True)
    if r["status"] != "ACCEPTED":
        raise RuntimeError(f"seed command {key} failed: {r}")
    return r


async def seed_activity(session) -> None:
    """A realistic morning: some gear out on trek, one damaged return awaiting review."""
    brt = sid("batch:BRT-1012")
    due = (TODAY + timedelta(days=5)).isoformat()
    issues = [
        ("JKT-015", "Vikram Singh"),
        ("JKT-017", "Rahul Mehta"),
        ("POL-008", "Rahul Mehta"),
        ("SBG-009", "Sneha Patil"),
        ("BPK-007", "Arjun Gupta"),
        ("JKT-016", "Meera Iyer"),
    ]
    for tag, who in issues:
        await run_command(
            session,
            "aditi",
            "ISSUE_GEAR",
            sid(f"item:{tag}"),
            {
                "allocation_id": str(sid(f"alloc:{tag}:{who}")),
                "trekker_id": str(sid(f"trekker:{who}")),
                "batch_id": str(brt),
                "due_date": due,
            },
            f"issue:{tag}",
        )
    # A good return, released by the supervisor, so history shows a full cycle.
    await run_command(
        session,
        "aditi",
        "SUBMIT_RETURN",
        sid("item:JKT-016"),
        {
            "inspection_id": str(sid("insp:JKT-016:1")),
            "allocation_id": str(sid("alloc:JKT-016:Meera Iyer")),
            "form_version_id": str(sid("form:return-inspection:v3")),
            "answers": {"equipment": str(sid("item:JKT-016")), "condition": "GOOD"},
        },
        "return:JKT-016",
    )
    await run_command(
        session,
        "ananya",
        "RELEASE_EQUIPMENT",
        sid("item:JKT-016"),
        {"inspection_id": str(sid("insp:JKT-016:release")), "result": "PASS", "notes": "Clean, zips OK"},
        "release:JKT-016",
    )
    # In-flight handover Sankri → Lohajung awaiting receipt (5 items).
    await run_command(
        session,
        "ananya",
        "DISPATCH_TRANSFER",
        sid("transfer:demo-1"),
        {
            "from_location_id": str(sid("loc:Sankri Store")),
            "to_location_id": str(sid("loc:Lohajung Store")),
            "item_ids": [
                str(sid(f"item:{t}")) for t in ("JKT-022", "POL-015", "SHO-015", "BPK-015", "SBG-015")
            ],
            "note": "Jeep, driver Tashi",
        },
        "dispatch:demo-1",
    )


async def main(do_reset: bool) -> None:
    async with sessionmaker()() as session:
        if do_reset:
            async with session.begin():
                await reset(session)
        async with session.begin():
            await seed_reference(session)
            await emit_reference(session)
        await seed_activity(session)
    print("Seeded demo organisation: 2 camps, 4 users, 20 trekkers, 50 assets.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="truncate all TrailOps tables first (demo only)")
    asyncio.run(main(ap.parse_args().reset))
