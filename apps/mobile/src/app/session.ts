/** Ephemeral UI/session state (zustand). Persistent records stay in WatermelonDB only (spec §2 stack table). */
import type {Database} from '@nozbe/watermelondb';
import {create} from 'zustand';
import type {AccountMarker} from '../auth/session';
import type {Me} from '../sync/coordinator';

export type Phase = 'starting' | 'signedOut' | 'locked' | 'campSelect' | 'ready' | 'dbError';

interface SessionState {
  phase: Phase;
  account: AccountMarker | null;
  db: Database | null;
  me: Me | null;
  campId: string | null;
  error: string | null;
  set: (p: Partial<SessionState>) => void;
}

export const useSession = create<SessionState>(set => ({
  phase: 'starting',
  account: null,
  db: null,
  me: null,
  campId: null,
  error: null,
  set: p => set(p),
}));

export function useDb(): Database {
  const db = useSession(s => s.db);
  if (!db) throw new Error('database not open');
  return db;
}

export function can(me: Me | null, permission: string): boolean {
  // Cached permissions authorize local capture only; the server rechecks on sync (spec §4).
  return !!me?.permissions.includes(permission);
}
