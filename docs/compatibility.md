# Compatibility record (spec §2 stack gate)

Tested 13 Oct 2026 on Windows 11 host. Only what was actually run is listed.

## Toolchain

| Tool | Version |
| --- | --- |
| Node | 24.16.0 |
| pnpm | 11.9.0 (web + contracts workspace) |
| npm | bundled with Node (mobile app; see below) |
| JDK | Android Studio bundled JBR |
| Android SDK | compile/target 36, build-tools 36.0.0, NDK 27.1.12297006 |
| Python / uv | 3.13.2 / 0.13.0 |
| PostgreSQL | 17 (Docker) |
| Keycloak | 26.0 (Docker, port 8180 because 8080 was taken on the host) |

## Mobile stack (Android, M0 spike)

| Package | Version | Result |
| --- | --- | --- |
| react-native | 0.81.6, **legacy architecture** (`newArchEnabled=false`) | Debug APK builds (Gradle 5 min cold) and runs on emulator API 36 x86_64 |
| @nozbe/watermelondb | 0.28.0, SQLite adapter, `jsi: false` | Write → force-stop → relaunch: rows persisted (2/2) |
| react-native-keychain | 10.0.0 | set/get generic password OK |
| react-native-blob-util | 0.22.2 | file write + native SHA-256 correct (`hello` → `2cf24dba…`) |
| react-native-vision-camera | 4.7.3, code scanner on, frame processors off | Module loads, 2 camera devices enumerated; QR decode not yet verified |
| react-native-app-auth | 8.0.3 | builds; sign-in flow verified later |

### Why legacy architecture and React Native 0.81

WatermelonDB 0.28.0 (last release July 2025) ships a legacy native module plus an optional JSI
installer. React Native 0.82+ removed the legacy architecture, so 0.81.x is the newest line where
the old bridge is still available as a fallback. The async (non-JSI) SQLite adapter is used; JSI
can be evaluated later against PERF-01 measurements.

### Mobile package manager

`apps/mobile` is excluded from the pnpm workspace and uses npm with a committed
`package-lock.json`. Metro resolves `@trailops/contracts` through `watchFolders` +
`extraNodeModules` (see `apps/mobile/metro.config.js`). This avoids Metro/pnpm symlink problems.

## Not verified

- iOS: not built (no macOS host). Treat iOS as unverified.
- Physical Android device: not yet tested.
- MinIO: public images could not be pulled; API uses local signed-slot storage. S3 code path untested.
