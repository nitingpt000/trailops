# TrailOps

Offline-first equipment operations for trek base camps: issue, return/inspection with photo evidence,
repair approval, tagged-asset handovers and conflict reconciliation, with a FastAPI backend and an
online supervisor console.

> **Independent applicant concept · sample data.** Not an Indiahikes product, not connected to any
> Indiahikes system, and not based on their internal architecture. All people and records are fictional.
> Built from `TrailOps-Technical-Documentation.md` (the spec) and the `trailops-assets` pack.

## What is in the repository

| Path | What it is |
| --- | --- |
| `services/api` | Python 3.13 / FastAPI modular monolith, SQLAlchemy 2 async, Alembic, PostgreSQL |
| `apps/mobile` | React Native CLI 0.81 app (Android verified), WatermelonDB, custom command sync |
| `apps/web` | React + TypeScript + Vite supervisor console (online only) |
| `packages/contracts` | Shared TS types, form engine, QR label codec, fixtures shared with the API tests |
| `infra` | Docker Compose (PostgreSQL 17, Keycloak 26) and the demo realm export |
| `docs` | Build progress, compatibility record, demo script |

## Architecture in one paragraph

Devices never edit authoritative rows. Every user action becomes an immutable, idempotent **command**
(`ISSUE_GEAR`, `SUBMIT_RETURN`, `DISPATCH_TRANSFER`, …) persisted in a local durable queue in the same
transaction as its local draft/attachment bookkeeping. The server runs each command in one PostgreSQL
transaction behind a per-organisation commit gate, persists a terminal receipt (accepted / rejected /
conflict) so retries replay the original result, and appends audit events plus a **commit-ordered
change log** with before/after visibility scopes. Devices pull scoped changes with HMAC-signed,
scope-bound cursors (tombstones when an entity leaves scope) and render *confirmed projection +
pending overlays*, so a provisional offline issue is never shown as confirmed. Photos travel separately
through short-lived upload slots and are verified (size, SHA-256, signature, decode, EXIF strip) before
they can unlock any workflow. Conflicts are first-class records with a custody claim that blocks the
item until a person reconciles physical reality.

## Run it locally

Prerequisites: Docker, Python 3.13 + `uv`, Node 24 + pnpm 11, Android SDK/JDK for the app.

```bash
docker compose -f infra/compose.yml up -d postgres keycloak
```

```bash
uv --directory services/api sync
```

```bash
uv --directory services/api run alembic upgrade head
```

```bash
uv --directory services/api run python -m app.demo.seed --reset
```

```bash
uv --directory services/api run uvicorn app.main:app --port 8000 --host 0.0.0.0
```

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter web dev
```

Keycloak runs on **8180** (8080 was taken on the build host). Console: <http://localhost:5173>.

### Android app

```bash
npm --prefix apps/mobile ci
```

```bash
npm --prefix apps/mobile run start
```

```bash
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8180 tcp:8180
```

```bash
npm --prefix apps/mobile run android
```

`adb reverse` lets the device use `localhost`, so the token issuer matches the API's configured issuer
exactly. A standalone release APK (JS bundled) is built with `./gradlew assembleRelease` in
`apps/mobile/android`; it is signed with the template debug keystore and is for demos only.

### Demo accounts (local Keycloak realm, demo password `trailops-demo`)

| User | Role | Scope |
| --- | --- | --- |
| `aditi` | Camp operator | Lohajung |
| `ramesh` | Trek leader | Lohajung |
| `ananya` | Supervisor | Lohajung + Sankri |
| `kabir` | Administrator | Organisation-wide |

## Tests (actual results on the build machine)

| Suite | Command | Result |
| --- | --- | --- |
| API integration (real PostgreSQL) | `uv --directory services/api run pytest` | 87 passed |
| Web console (command helper, form-editor reducer, permissions) | `pnpm --filter web test` | 23 passed |
| Shared contracts (form engine fixtures, QR, retry) | `pnpm --filter @trailops/contracts test` | 28 passed |
| Mobile unit (queue, projection adapter, receipts, hashing) | `npm --prefix apps/mobile test` | 11 passed |

The API suite covers the spec §27 IDs AUTH-01..04, EQ-01, ISSUE-01..03, SYNC-01/02/05/06/07/09/10,
RET-01/02, REPAIR-01, TR-01..03, FORM-01..03, PHOTO-01/02, CONFLICT-01/02, including a real
two-device race on the same jacket and a concurrent commit/pull ordering test.

## Demo (spec §28) — what has been run on an Android emulator against the real stack

1. Sign in as Aditi through the system browser (PKCE), download Lohajung data. ✔
2. Cut the device's route to the API/identity server; issue JKT-018 to Priya Nair. ✔
3. "Saved on this device — awaiting server confirmation"; force-close and reopen: still pending. ✔
4. A second actor issues JKT-018 to Karan centrally (`python -m app.demo.second_device`). ✔
5. Reconnect: conflict shown with the confirmed allocation and the preserved local claim. ✔
6. Resolve by replacement (JKT-020 to Priya); server shows both allocations, conflict + claim resolved. ✔
7. Return JKT-020 as "needs repair" with a camera photo; evidence uploads and verifies. ✔
8. Supervisor (Ananya) reviews the real evidence on the phone and approves (online-only command). ✔
9. Dispatch five tagged items Lohajung → Sankri; receive four, one missing → discrepancy, missing item
   stays blocked at origin. ✔
10. Publish inspection v4 from the console form editor (as `kabir`; supervisors draft, administrators
    publish) while an old v3 draft stays valid (API test FORM-01). ✔
11. Complete the repair lifecycle in the console (start → complete → release inspection); the audit trail
    attributes every step across phone and console. ✔

## Known limitations (honest list)

- iOS has not been built or run (no macOS host). Android only.
- React Native 0.81 on the **legacy architecture**, chosen for WatermelonDB 0.28 compatibility.
- MinIO images were not pullable; evidence uses the API's local signed-slot storage. S3 path untested.
- Trek-leader "assigned batches only" is enforced at camp scope only.
- Form publication is administrator-only by default (the spec's "optional permission" for supervisors is an
  org-level grant, not a camp-level one).
- Console tests cover logic only (no component/E2E tests); ESLint is not configured.
- No automated device-level tests (Detox/Maestro); device flows were exercised manually via adb.
- Retention/cleanup jobs, push notifications and integrations are interfaces/plans, not implemented.
- The 72-hour offline allowance, grace periods and approval rules are proposals needing stakeholder input.
