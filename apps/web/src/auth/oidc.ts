import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { config } from '../config';

/**
 * OIDC Authorization Code + PKCE (S256) against Keycloak. Tokens live in sessionStorage only
 * (cleared when the tab closes); never localStorage. Silent renew uses the refresh token before
 * the access token expires.
 */
export const userManager = new UserManager({
  authority: config.oidcAuthority,
  client_id: config.oidcClientId,
  redirect_uri: `${window.location.origin}/auth/callback`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
  accessTokenExpiringNotificationTimeInSeconds: 60,
  monitorSession: false,
  loadUserInfo: false,
});

let current: User | null = null;
let refreshing: Promise<User | null> | null = null;

export function setCurrentUser(u: User | null) {
  current = u;
}

export function accessToken(): string | null {
  if (!current || current.expired) return null;
  return current.access_token;
}

/** Single-flight refresh used after a 401 or when the token is about to expire. */
export async function refreshToken(): Promise<User | null> {
  if (!refreshing) {
    refreshing = userManager
      .signinSilent()
      .then((u) => {
        current = u;
        return u;
      })
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function ensureFreshToken(): Promise<string | null> {
  if (current && current.expires_in !== undefined && current.expires_in < 30) {
    await refreshToken();
  }
  return accessToken();
}
