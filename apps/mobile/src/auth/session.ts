/**
 * Sign-in and credentials (spec §4). System browser Authorization Code + PKCE through
 * react-native-app-auth: no embedded password collection, no client secret. The refresh token lives
 * in the OS keystore via react-native-keychain; the access token only in memory.
 */
import {authorize, refresh, type AuthConfiguration} from 'react-native-app-auth';
import * as Keychain from 'react-native-keychain';
import {config} from '../app/config';
import {uuid} from '../native/sha256';

const AUTH_CONFIG: AuthConfiguration = {
  issuer: config.issuer,
  clientId: config.clientId,
  redirectUrl: config.redirectUrl,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  usePKCE: true,
  dangerouslyAllowInsecureHttpRequests: config.allowInsecureHttp,
};

const ACCOUNT_SERVICE = 'trailops.account';
const INSTALL_SERVICE = 'trailops.install';
const tokenService = (accountId: string) => `trailops.tokens.${accountId}`;

export interface AccountMarker {
  accountId: string; // OIDC `sub`
  displayName: string;
  deviceId: string | null;
  lastVerifiedAt: number | null; // last successful online policy check (GET /v1/me)
}

export class OfflineError extends Error {}
export class AuthExpiredError extends Error {}

let memory: {accessToken: string; expiresAt: number; accountId: string} | null = null;

function decodeSub(jwt: string): {sub: string; name?: string; preferred_username?: string} {
  // Not a verification: only reads the subject of a token we just received from the issuer. The API
  // validates every token it receives.
  const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(
    Array.from(globalThis.atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')))
      .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
  );
  return JSON.parse(json);
}

export async function readAccount(): Promise<AccountMarker | null> {
  const r = await Keychain.getGenericPassword({service: ACCOUNT_SERVICE});
  return r ? (JSON.parse(r.password) as AccountMarker) : null;
}

export async function writeAccount(marker: AccountMarker): Promise<void> {
  await Keychain.setGenericPassword(marker.accountId, JSON.stringify(marker), {
    service: ACCOUNT_SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function installationId(): Promise<string> {
  const r = await Keychain.getGenericPassword({service: INSTALL_SERVICE});
  if (r) return r.password;
  const id = uuid();
  await Keychain.setGenericPassword('install', id, {service: INSTALL_SERVICE});
  return id;
}

export async function signIn(): Promise<AccountMarker> {
  const result = await authorize(AUTH_CONFIG);
  const claims = decodeSub(result.accessToken);
  const previous = await readAccount();
  memory = {
    accessToken: result.accessToken,
    expiresAt: Date.parse(result.accessTokenExpirationDate),
    accountId: claims.sub,
  };
  await Keychain.setGenericPassword(claims.sub, result.refreshToken, {
    service: tokenService(claims.sub),
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  const marker: AccountMarker = {
    accountId: claims.sub,
    displayName: claims.name ?? claims.preferred_username ?? 'Signed in',
    deviceId: previous?.accountId === claims.sub ? previous.deviceId : null,
    lastVerifiedAt: previous?.accountId === claims.sub ? previous.lastVerifiedAt : null,
  };
  await writeAccount(marker);
  return marker;
}

/** Returns a valid access token, refreshing once if needed. Throws OfflineError / AuthExpiredError. */
export async function accessToken(accountId: string, force = false): Promise<string> {
  if (!force && memory && memory.accountId === accountId && memory.expiresAt - Date.now() > 30_000) {
    return memory.accessToken;
  }
  const stored = await Keychain.getGenericPassword({service: tokenService(accountId)});
  if (!stored) throw new AuthExpiredError('Sign in again to sync.');
  try {
    const r = await refresh(AUTH_CONFIG, {refreshToken: stored.password});
    memory = {accessToken: r.accessToken, expiresAt: Date.parse(r.accessTokenExpirationDate), accountId};
    if (r.refreshToken) {
      await Keychain.setGenericPassword(accountId, r.refreshToken, {
        service: tokenService(accountId),
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    }
    return r.accessToken;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/invalid_grant|Token is not active|Session not active/i.test(msg)) {
      throw new AuthExpiredError('Your session ended. Sign in again to sync.');
    }
    throw new OfflineError('Could not reach the identity service.');
  }
}

/** Removes credentials only. Callers must first ensure no pending work would be stranded (spec §4). */
export async function forgetCredentials(accountId: string): Promise<void> {
  memory = null;
  await Keychain.resetGenericPassword({service: tokenService(accountId)});
}

export function offlineAllowanceExpired(marker: AccountMarker, hours: number, now = Date.now()): boolean {
  return marker.lastVerifiedAt == null || now - marker.lastVerifiedAt > hours * 3600_000;
}
