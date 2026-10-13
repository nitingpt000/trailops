/**
 * Startup order (spec §9): read secure account marker → open account DB → migrate → validate cached
 * allowance → select camp → render local data → refresh credentials/permissions online → start sync.
 * No network request blocks local navigation.
 */
import {AppState} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {config} from './config';
import {useSession} from './session';
import {offlineAllowanceExpired, readAccount, signIn} from '../auth/session';
import {getMeta, lastSetupError, openDatabase, closeDatabase} from '../database';
import type {LocalRecord, SyncMetaRow} from '../database/models';
import {runSync, useSync, type Me} from '../sync/coordinator';
import {pendingQuery} from '../sync/queue';

let listenersInstalled = false;

export async function startup(): Promise<void> {
  const set = useSession.getState().set;
  const marker = await readAccount();
  if (!marker) {
    set({phase: 'signedOut'});
    return;
  }
  let db;
  try {
    db = openDatabase(marker.accountId);
    var meta = await getMeta(db, marker.accountId); // eslint-disable-line no-var
  } catch (e) {
    set({phase: 'dbError', error: String(lastSetupError ?? e)});
    return;
  }
  const me: Me | null = meta.r.me_json ? JSON.parse(meta.r.me_json) : null;
  set({account: marker, db, me});
  installListeners();

  if (offlineAllowanceExpired(marker, me?.offline_allowance_hours ?? config.offlineAllowanceHours)) {
    // Try to re-verify online; if that fails, lock protected data but keep pending work.
    set({phase: 'locked'});
    await runSync(db, 'allowance-check');
    const fresh = await readAccount();
    if (!fresh || offlineAllowanceExpired(fresh, config.offlineAllowanceHours)) return;
    await afterVerified(meta);
    return;
  }
  await enterCamp(meta);
  void runSync(db, 'startup');
}

async function afterVerified(meta: LocalRecord<SyncMetaRow>) {
  const {set} = useSession.getState();
  const account = await readAccount();
  set({account, me: meta.r.me_json ? JSON.parse(meta.r.me_json) : null});
  await enterCamp(meta);
}

async function enterCamp(meta: LocalRecord<SyncMetaRow>) {
  const {set} = useSession.getState();
  const me: Me | null = meta.r.me_json ? JSON.parse(meta.r.me_json) : null;
  const camps = me?.camps ?? [];
  const chosen = meta.r.camp_id && camps.some(c => c.id === meta.r.camp_id) ? meta.r.camp_id : null;
  if (chosen) set({campId: chosen, phase: 'ready'});
  else if (camps.length === 1) await chooseCamp(camps[0].id);
  else set({phase: camps.length ? 'campSelect' : 'ready'});
}

export async function chooseCamp(campId: string) {
  const {db, account, set} = useSession.getState();
  if (!db || !account) return;
  const meta = await getMeta(db, account.accountId);
  await db.write(() => meta.update(m => (m as LocalRecord<SyncMetaRow>).set({camp_id: campId})));
  set({campId, phase: 'ready'});
}

/** First sign-in requires connectivity; downloads camp data before showing the app. */
export async function signInAndLoad(): Promise<void> {
  const set = useSession.getState().set;
  const prev = useSession.getState().account;
  const marker = await signIn();
  if (prev && prev.accountId !== marker.accountId) closeDatabase(); // never mix accounts
  const db = openDatabase(marker.accountId);
  set({account: marker, db});
  installListeners();
  await runSync(db, 'first-sign-in');
  const meta = await getMeta(db, marker.accountId);
  if (!meta.r.me_json) {
    throw new Error(useSync.getState().lastError ?? 'Could not download camp data. Check the connection.');
  }
  await afterVerified(meta);
}

/** Sign-out is blocked while work is pending, so nothing is silently discarded (spec §4). */
export async function pendingCount(): Promise<number> {
  const {db, account} = useSession.getState();
  if (!db || !account) return 0;
  return pendingQuery(db, account.accountId).fetchCount();
}

export function triggerSync(reason: string) {
  const {db} = useSession.getState();
  if (db) void runSync(db, reason);
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  // Foreground and connectivity restoration are hints; sync handles failures itself (spec §18).
  AppState.addEventListener('change', s => {
    if (s === 'active') triggerSync('foreground');
  });
  let wasConnected: boolean | null = null;
  NetInfo.addEventListener(state => {
    const connected = !!state.isConnected;
    if (connected && wasConnected === false) triggerSync('reconnect');
    if (!connected) useSync.getState().set({online: false});
    wasConnected = connected;
  });
}
