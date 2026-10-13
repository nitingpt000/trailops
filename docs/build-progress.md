# Build progress

Tracks implementation against `TrailOps-Technical-Documentation.md` §25 milestones. States only what
was actually built and run on the build machine (Windows 11, Android emulator API 36).

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 compatibility spike | Done (Android) | `docs/compatibility.md`; DB restart durability, keychain, native hashing, camera |
| M1 foundations | Done | Reviewed Alembic migration (up/down/up), Keycloak realm, deterministic seed, scoped reads |
| M2 vertical issue slice | Done | Offline issue on emulator survives force-close, confirms once |
| M3 sync correctness | Done | 77 API tests incl. lost responses, concurrent devices, tombstones, scope change |
| M4 return/repair | Done | Camera photo → upload → server verification → approval on phone |
| M5 handovers | Done | Five dispatched / four received on emulator; missing item blocked at origin |
| M6 console/forms | Done | Console flows exercised in the browser; v4 published while v3 drafts stay valid |
| M7 reviewer package | Partly | README, CI workflow, release APK (debug-signed, demo only); no demo video |

## Test results

| Suite | Result |
| --- | --- |
| API (`uv run pytest`, PostgreSQL 17) | 87 passed |
| Web console (`pnpm --filter web test`) | 23 passed; typecheck + production build OK |
| Contracts (`pnpm --filter @trailops/contracts test`) | 28 passed |
| Mobile (`npm test` in apps/mobile) | 11 passed |

## Verified on the emulator (manual, adb-driven)

Spec §28 steps 1–9: PKCE sign-in, offline issue, durable restart, second-actor conflict, replacement
resolution, damaged return with real photo, evidence verification, supervisor approval with real
evidence, per-tag dispatch/receipt with discrepancy. Release APK upgrade in place keeps account + DB.

## Bugs found and fixed while verifying

| Where | Bug | Fix |
| --- | --- | --- |
| API cursors / upload slots | Token split on a `.` byte that the binary MAC can contain (~6% rejected) | Fixed-length MAC suffix + regression test |
| API evidence | EXIF strip dropped orientation → photos rotated | `exif_transpose` before re-encode + test |
| API worker | Compared host clock to DB clock; jobs looked "not yet available" | Database time only |
| Mobile adapter | Two events for one entity in a pull page → WatermelonDB batch error | Collapse to newest per entity + test |
| Mobile return | Photo answers pruned before validation → "add a photo" with a photo attached | Merge photo ids before pruning |
| Mobile auth | Browser SSO cookie silently re-used previous user on a shared phone | `prompt=login` |
| Mobile review | Pack's stock zip image looked like evidence | Show real verified evidence via short-lived URLs |
| Keycloak realm | Explicit realm roles dropped `offline_access` | Added to realm export |
| API handovers | Extra-items-only discrepancy could never reconcile | Shared reconcile check + tests |
| API conflicts read | Receiving camp could not see missing-item claims | Scope by destination too + test |
| API commands | No version checks on discrepancy/claim/membership edits | Optimistic checks + tests |

## Decisions taken where the spec left room

- `org_id` is the single column naming convention.
- `inspections.evidence_state` adds `NOT_REQUIRED` so "verified" is never claimed for absent evidence.
- UNUSABLE returns create a `DISPOSITION` request; approving it retires the item.
- A rejected ISSUE_GEAR always records a conflict and a custody claim; the claim blocks the item until reconciled.
- Mobile on React Native 0.81 legacy architecture for WatermelonDB 0.28 (see compatibility record).

## Not done / open

- iOS build; physical-device test; Detox/Maestro automation; SYNC-03/04/08 and MIG-01 as automated device tests.
- Trek-leader batch assignment; integration adapters (interfaces only in spec); push notifications.
- Demo video.
