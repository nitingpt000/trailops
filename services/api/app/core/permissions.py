"""Coarse role → permission mapping (spec §4 permission matrix).

Camp scope is applied separately: a permission alone never grants access to a camp the user is not
a member of, unless the membership is organization-wide.
"""

FIELD = {
    "equipment.read",
    "issue.create",
    "return.submit",
    "inspection.submit",
    "conflict.resolve_local",
}

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "camp_operator": frozenset(FIELD | {"transfer.dispatch", "transfer.receive"}),
    # Trek leaders issue/return for batches; transfers are not granted by default.
    "trek_leader": frozenset(FIELD),
    "supervisor": frozenset(
        FIELD
        | {
            "transfer.dispatch",
            "transfer.receive",
            "transfer.resolve",
            "repair.approve",
            "repair.work",
            "repair.release",
            "equipment.retire",
            "conflict.resolve",
            "audit.read",
            "forms.edit",
            "equipment.manage",
            "dashboard.read",
        }
    ),
    "administrator": frozenset(
        {
            "equipment.read",
            "conflict.resolve",
            "conflict.resolve_local",
            "audit.read",
            "forms.edit",
            "forms.publish",
            "access.manage",
            "equipment.manage",
            "dashboard.read",
        }
    ),
}

# Commands that are never allowed from an offline-captured queue (spec §4 offline policy).
ONLINE_ONLY_COMMANDS = {"APPROVE_REPAIR", "FORM_PUBLISH", "MEMBERSHIP_UPDATE"}


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())
