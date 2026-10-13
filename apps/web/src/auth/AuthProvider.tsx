import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from 'oidc-client-ts';
import { setCurrentUser, userManager } from './oidc';

interface AuthState {
  user: User | null;
  ready: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

let initPromise: Promise<{ user: User | null; error: string | null }> | null = null;

/** Single-flight start-up: completes a redirect callback at most once (StrictMode runs effects twice). */
function initAuth() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        if (window.location.pathname === '/auth/callback') {
          const u = await userManager.signinRedirectCallback();
          const target = typeof u.state === 'string' && u.state.startsWith('/') ? u.state : '/';
          window.history.replaceState({}, '', target);
          return { user: u, error: null };
        }
        const u = await userManager.getUser();
        if (u && u.expired) {
          try {
            return { user: await userManager.signinSilent(), error: null };
          } catch {
            await userManager.removeUser();
            return { user: null, error: null };
          }
        }
        return { user: u, error: null };
      } catch (e) {
        window.history.replaceState({}, '', '/');
        return { user: null, error: e instanceof Error ? e.message : 'Sign-in failed' };
      }
    })();
  }
  return initPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (u: User | null) => {
      setCurrentUser(u);
      if (!cancelled) setUser(u);
    };
    initAuth()
      .then((r) => {
        apply(r.user);
        if (r.error && !cancelled) setError(r.error);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    const onLoaded = (u: User) => apply(u);
    const onUnloaded = () => apply(null);
    const onRenewError = () => setError('Your session could not be renewed. Please sign in again.');
    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addSilentRenewError(onRenewError);
    return () => {
      cancelled = true;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeSilentRenewError(onRenewError);
    };
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    const here = window.location.pathname + window.location.search;
    await userManager.signinRedirect({ state: here === '/auth/callback' ? '/' : here });
  }, []);

  const signOut = useCallback(async () => {
    const idToken = user?.id_token;
    setCurrentUser(null);
    await userManager.removeUser();
    sessionStorage.clear();
    await userManager.signoutRedirect({ id_token_hint: idToken });
  }, [user]);

  const value = useMemo(() => ({ user, ready, error, signIn, signOut }), [user, ready, error, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
