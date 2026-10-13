# Build progress

Tracks implementation against `TrailOps-Technical-Documentation.md` §25 milestones. Only states what
has actually been built and run on this machine.

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 compatibility spike | Not started | Toolchain present: Android SDK 35/36, JDK (Android Studio JBR), Node 24, pnpm 11, Docker 28, Python 3.13 |
| M1 foundations | Backend done | Schema + reviewed Alembic migration (up/down tested), scoped reads, deterministic demo seed |
| M2 vertical issue slice | Backend done | ISSUE_GEAR, durable receipts, idempotent replay |
| M3 sync correctness | Backend done | Commit-ordered change stream, signed scope-bound cursors, tombstones, rebootstrap on scope change |
| M4 return/repair | Backend done | Versioned inspection, evidence placeholders + verification, approval/work/release |
| M5 handovers | Backend done | All-or-nothing dispatch, per-tag receipt, missing/extra custody claims, dependency wait |
| M6 console/forms | Backend done; console UI not started | Form engine + draft/publish commands |
| M7 reviewer package | Not started | |

## Backend test results (real PostgreSQL 17)

`uv run pytest` in `services/api`: 76 passed. Covers spec §27 IDs AUTH-01..04, EQ-01, ISSUE-01..03,
SYNC-01, 02, 05, 06, 07, 09, 10, RET-01..02, REPAIR-01, TR-01..03, FORM-01..03, PHOTO-01..02,
CONFLICT-01..02, plus shared form-fixture conformance.

Not yet covered: SYNC-03/04/08 and MIG-01 (client-side, need the mobile app), PERF-01 (device).

## Bugs found by tests

- Sync cursor / upload-slot tokens were split on a `.` byte, which the binary MAC can contain;
  ~6% of cursors were rejected. Fixed with a fixed-length MAC suffix plus a regression test.

## Decisions taken where the spec left room

- `org_id` is the single column naming convention.
- `inspections.evidence_state` adds `NOT_REQUIRED` for returns with no photos, so "verified" is never
  claimed for evidence that does not exist.
- UNUSABLE returns create a `DISPOSITION` request; approving it retires the item, denying needs an
  explicit disposition.
- A rejected ISSUE_GEAR always records a conflict and a custody claim (the operator may already have
  handed the item over). The claim blocks release/issue until reconciled.
- Trek-leader "assigned batches only" is not yet enforced beyond camp scope (no batch-leader table).

## Next

1. Web console (React + Vite): equipment, approvals/repair lifecycle, handovers, conflicts, audit, form editor.
2. React Native CLI app with WatermelonDB, command queue, attachment queue, QR scanning.
3. Keycloak realm export with the four demo users; end-to-end sign-in.
