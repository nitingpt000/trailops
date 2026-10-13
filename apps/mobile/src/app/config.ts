/**
 * Device-reachable service addresses. On the Android emulator run
 * `adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8180 tcp:8180` so `localhost` reaches the host and
 * the token issuer matches the API's configured OIDC_ISSUER exactly (spec §26).
 * Plain HTTP is a local development exception only: release builds disable cleartext traffic.
 */
export const config = {
  apiBase: 'http://localhost:8000',
  issuer: 'http://localhost:8180/realms/trailops',
  clientId: 'trailops-mobile',
  redirectUrl: 'trailops://auth/callback',
  protocolVersion: 1,
  offlineAllowanceHours: 72,
  maxBatch: 50,
  allowInsecureHttp: __DEV__,
};
