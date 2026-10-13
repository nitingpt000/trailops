import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, MeCamp } from '../api/types';

export interface Session {
  me: Me;
  camp: MeCamp | null;
  setCampId: (id: string) => void;
  /** UI convenience only — the server enforces every permission again. */
  can: (permission: string, campId?: string | null) => boolean;
  canAny: (permissions: string[], campId?: string | null) => boolean;
}

const SessionContext = createContext<Session | null>(null);
const CAMP_KEY = 'trailops.camp';

export function hasPermission(me: Me, permission: string, campId?: string | null): boolean {
  if (me.permissions.includes(permission)) {
    return !campId || me.org_wide || me.camps.some((c) => c.id === campId);
  }
  if (!campId) return me.camps.some((c) => c.extra_permissions.includes(permission));
  return !!me.camps.find((c) => c.id === campId)?.extra_permissions.includes(permission);
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [campId, setCampIdState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(CAMP_KEY);
    } catch {
      return null;
    }
  });
  const camp = me.camps.find((c) => c.id === campId) ?? me.camps[0] ?? null;
  useEffect(() => {
    if (camp && camp.id !== campId) setCampIdState(camp.id);
  }, [camp, campId]);
  const setCampId = useCallback((id: string) => {
    setCampIdState(id);
    try {
      sessionStorage.setItem(CAMP_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<Session>(
    () => ({
      me,
      camp,
      setCampId,
      can: (p, c) => hasPermission(me, p, c === undefined ? camp?.id : c),
      canAny: (ps, c) => ps.some((p) => hasPermission(me, p, c === undefined ? camp?.id : c)),
    }),
    [me, camp, setCampId],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

export const ROLE_LABEL: Record<string, string> = {
  camp_operator: 'Camp operator',
  trek_leader: 'Trek leader',
  supervisor: 'Supervisor',
  administrator: 'Administrator',
};
