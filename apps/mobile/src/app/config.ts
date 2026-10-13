/**
 * Device-reachable service addresses. On the Android emulator run
 * `adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8180 tcp:8180` so `localhost` reaches the host and
 * the token issuer matches the API's configured OIDC_ISSUER exactly (spec §26).
 */
const issuer = 'http://localhost:8180/realms/trailops';

/** Plain HTTP is tolerated only for loopback/emulator hosts (local demo). Real deployments use TLS. */
export function isLoopbackHttp(url: string): boolean {
  return /^http:\/\/(localhost|10\.0\.2\.2)(:\d+)?(\/|$)/.test(url);
}

export const config = {
  apiBase: 'http://localhost:8000',
  issuer,
  clientId: 'trailops-mobile',
  redirectUrl: 'trailops://auth/callback',
  protocolVersion: 1,
  offlineAllowanceHours: 72,
  maxBatch: 50,
  allowInsecureHttp: isLoopbackHttp(issuer),
};
