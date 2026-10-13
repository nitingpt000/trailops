/**
 * Reconnect coordinator (spec §18):
 * 1 single-flight per account/device → 2 refresh credentials + scope policy → 3 epoch/cursor checks,
 * re-bootstrap if needed (queue and files preserved) → 4 pull before push → 5 push eligible commands
 * in dependency order, persisting each receipt → 6 upload evidence for accepted parents → 7 pull again
 * → 8 record success only for completed phases.
 */
import {Q, type Database, type Model} from '@nozbe/watermelondb';
import {create} from 'zustand';
import {retryDelayMs, type BootstrapResponse, type ChangesResponse, type Receipt} from '@trailops/contracts';
import {config} from '../app/config';
import {AuthExpiredError, OfflineError, installationId, readAccount, writeAccount, type AccountMarker} from '../auth/session';
import {getMeta} from '../database';
import {useSession} from '../app/session';
import type {AttachmentRow, LocalConflictRow, LocalRecord, QueueRow, SyncMetaRow} from '../database/models';
import {HttpError, NetworkError, api, type ApiContext} from './api';
import {applyEvents, changeToIncoming, replaceSnapshot} from './projectionAdapter';
import {queueTable} from './queue';
import {uploadReadyAttachments} from './attachments';
import {refreshOrgLocations} from './orgLocations';

export interface Me {
  user: {id: string; display_name: string; email: string | null};
  role: string;
  permissions: string[];
  org_wide: boolean;
  camps: {id: string; code: string; name: string; timezone: string}[];
  scope_epoch: number;
  offline_allowance_hours: number;
  server_time: string;
}

interface SyncState {
  running: boolean;
  phase: string | null;
  online: boolean | null;
  authBlocked: boolean;
  lastError: string | null;
  lastRunAt: number | null;
  set: (p: Partial<SyncState>) => void;
}

export const useSync = create<SyncState>(set => ({
  running: false,
  phase: null,
  online: null,
  authBlocked: false,
  lastError: null,
  lastRunAt: null,
  set: p => set(p),
}));

let inFlight: Promise<void> | null = null;

/** Keep the session's permissions current and leave a camp the user can no longer access (spec §4). */
function applyScope(me: Me) {
  const session = useSession.getState();
  const campStillAllowed = !!session.campId && me.camps.some(c => c.id === session.campId);
  if (campStillAllowed) {
    session.set({me});
  } else if (me.camps.length === 1) {
    session.set({me, campId: me.camps[0].id});
  } else {
    session.set({me, campId: null, phase: me.camps.length ? 'campSelect' : 'ready'});
  }
}

export function runSync(db: Database, reason: string): Promise<void> {
  if (inFlight) return inFlight; // single-flight
  inFlight = doSync(db, reason).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync(db: Database, _reason: string): Promise<void> {
  const s = useSync.getState();
  const marker = await readAccount();
  if (!marker) return;
  s.set({running: true, phase: 'Checking access', lastError: null});
  const meta = await getMeta(db, marker.accountId);
  try {
    const ctx = await ensureDevice(marker);
    const me = await api<Me>(ctx, 'GET', '/v1/me');
    await writeAccount({...(await readAccount())!, lastVerifiedAt: Date.now(), displayName: me.user.display_name});
    await db.write(() =>
      meta.update(m => (m as LocalRecord<SyncMetaRow>).set({me_json: JSON.stringify(me), last_verified_at: Date.now()})),
    );
    s.set({online: true, authBlocked: false});
    applyScope(me);
    await unblockAuth(db, marker.accountId);

    // Labels for other camps' locations (handover origins/destinations); failure is non-fatal.
    await refreshOrgLocations(db, ctx).catch(() => undefined);

    s.set({phase: 'Downloading changes'});
    if (!meta.r.cursor || meta.r.scope_epoch !== me.scope_epoch) {
      await bootstrap(db, ctx, meta);
    }
    await pull(db, ctx, meta);

    s.set({phase: 'Sending saved changes'});
    const pushed = await push(db, ctx, marker.accountId);

    s.set({phase: 'Uploading photos'});
    await uploadReadyAttachments(db, ctx);

    if (pushed) {
      s.set({phase: 'Confirming'});
      await pull(db, ctx, meta);
      // Newly eligible dependents (e.g. a return after its issue) go in a second push.
      if (await push(db, ctx, marker.accountId)) await pull(db, ctx, meta);
      await uploadReadyAttachments(db, ctx);
    }
    await db.write(() => meta.update(m => (m as LocalRecord<SyncMetaRow>).set({last_success_at: Date.now(), last_error: null})));
  } catch (e) {
    const msg = describe(e);
    if (e instanceof OfflineError || e instanceof NetworkError) s.set({online: false});
    if (e instanceof AuthExpiredError) s.set({authBlocked: true, online: true});
    s.set({lastError: msg});
    await db.write(() => meta.update(m => (m as LocalRecord<SyncMetaRow>).set({last_error: msg}))).catch(() => undefined);
  } finally {
    s.set({running: false, phase: null, lastRunAt: Date.now()});
  }
}

function describe(e: unknown): string {
  if (e instanceof OfflineError || e instanceof NetworkError) return 'Offline. Changes stay on this device.';
  if (e instanceof AuthExpiredError) return e.message;
  if (e instanceof HttpError) return e.body?.error?.message ?? `Server error ${e.status}`;
  return String((e as Error)?.message ?? e);
}

async function ensureDevice(marker: AccountMarker): Promise<ApiContext> {
  if (marker.deviceId) return {accountId: marker.accountId, deviceId: marker.deviceId};
  const r = await api<{device_id: string}>({accountId: marker.accountId}, 'POST', '/v1/devices', {
    installation_id: await installationId(),
    platform: 'android',
    label: 'TrailOps Android',
  });
  await writeAccount({...marker, deviceId: r.device_id});
  return {accountId: marker.accountId, deviceId: r.device_id};
}

async function bootstrap(db: Database, ctx: ApiContext, meta: LocalRecord<SyncMetaRow>): Promise<void> {
  useSync.getState().set({phase: 'Downloading camp data'});
  const snap = await api<BootstrapResponse>(ctx, 'POST', '/v1/sync/bootstrap');
  // Staged and activated in one transaction; pending commands and photo files are untouched.
  await db.write(async () => {
    await replaceSnapshot(db, snap.records);
    await meta.update(m =>
      (m as LocalRecord<SyncMetaRow>).set({
        cursor: snap.cursor, scope_epoch: snap.scope_epoch, bootstrap_generation: snap.generation,
        last_pull_at: Date.now(),
      }),
    );
  });
}

async function pull(db: Database, ctx: ApiContext, meta: LocalRecord<SyncMetaRow>): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    let page: ChangesResponse;
    try {
      page = await api<ChangesResponse>(ctx, 'GET', `/v1/sync/changes?limit=200&cursor=${encodeURIComponent(meta.r.cursor ?? '')}`);
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'RESYNC_REQUIRED' || e.code === 'CURSOR_EXPIRED' || e.code === 'INVALID_CURSOR')) {
        await bootstrap(db, ctx, meta);
        continue;
      }
      throw e;
    }
    // A page and its cursor commit together; a crash before commit replays the page (SYNC-04).
    await db.write(async () => {
      await applyEvents(db, page.changes.map(changeToIncoming));
      await meta.update(m => (m as LocalRecord<SyncMetaRow>).set({cursor: page.next_cursor, last_pull_at: Date.now()}));
    });
    if (!page.has_more) return;
  }
}

async function unblockAuth(db: Database, accountId: string) {
  const rows = await queueTable(db).query(Q.where('account_id', accountId), Q.where('state', 'AUTH_BLOCKED')).fetch();
  if (rows.length) await db.write(() => db.batch(...rows.map(r => r.prepareUpdate(x => x.set({state: 'QUEUED'})))));
}

/** Returns true if anything was sent. */
async function push(db: Database, ctx: ApiContext, accountId: string): Promise<boolean> {
  const now = Date.now();
  const all = (await queueTable(db).query(Q.where('account_id', accountId), Q.sortBy('created_seq', Q.asc)).fetch());
  const byOp = new Map(all.map(r => [r.r.operation_id, r]));
  const eligible: LocalRecord<QueueRow>[] = [];
  const blocked: LocalRecord<QueueRow>[] = [];
  for (const row of all) {
    const st = row.r.state;
    if (!['QUEUED', 'SENDING', 'RETRY_WAIT', 'DEPENDENCY_WAIT'].includes(st)) continue;
    if ((st === 'RETRY_WAIT' || st === 'DEPENDENCY_WAIT') && row.r.next_retry_at && row.r.next_retry_at > now) continue;
    const deps: string[] = JSON.parse(row.r.depends_on_json);
    const failedDep = deps.map(d => byOp.get(d)).find(d => d && (d.r.state === 'CONFLICT' || d.r.state === 'REJECTED'));
    if (failedDep) {
      // Never send a return/transfer whose issue lost a conflict; it needs review (spec §19).
      if (row.r.error_code !== 'BLOCKED_BY_DEPENDENCY') blocked.push(row);
      continue;
    }
    eligible.push(row);
  }
  if (blocked.length) {
    await db.write(() => db.batch(...blocked.map(r => r.prepareUpdate(x => x.set({
      state: 'DEPENDENCY_WAIT', error_code: 'BLOCKED_BY_DEPENDENCY', next_retry_at: null,
      error_message: 'Waiting for review of an earlier action that was not accepted.',
    })))));
  }
  if (!eligible.length) return false;
  let sent = false;
  const pendingCount = all.filter(r => ['QUEUED', 'SENDING', 'RETRY_WAIT', 'DEPENDENCY_WAIT', 'AUTH_BLOCKED'].includes(r.r.state)).length;
  for (let i = 0; i < eligible.length; i += config.maxBatch) {
    const batch = eligible.slice(i, i + config.maxBatch);
    await db.write(() => db.batch(...batch.map(r => r.prepareUpdate(x => x.set({
      state: 'SENDING', attempts: x.r.attempts + 1, first_sent_at: x.r.first_sent_at ?? Date.now(),
    })))));
    let results: Receipt[];
    try {
      const res = await api<{results: Receipt[]}>(ctx, 'POST', '/v1/sync/commands', {
        protocol_version: config.protocolVersion,
        device_id: ctx.deviceId,
        pending_count: pendingCount,
        operations: batch.map(r => ({
          operation_id: r.r.operation_id,
          type: r.r.type,
          aggregate_id: r.r.aggregate_id,
          expected_version: r.r.expected_version,
          depends_on: JSON.parse(r.r.depends_on_json),
          preconditions: JSON.parse(r.r.preconditions_json),
          client_recorded_at: r.r.client_recorded_at,
          payload: JSON.parse(r.r.payload_json),
        })),
      });
      results = res.results;
      sent = true;
    } catch (e) {
      // No acknowledgement means no deletion: everything returns to a retryable state.
      const auth = e instanceof AuthExpiredError || (e instanceof HttpError && e.status === 401);
      await db.write(() => db.batch(...batch.map(r => r.prepareUpdate(x => x.set(
        auth
          ? {state: 'AUTH_BLOCKED', error_code: 'AUTH', error_message: 'Sign in again to send this change.'}
          : {state: 'RETRY_WAIT', next_retry_at: Date.now() + retryDelayMs(x.r.attempts - 1), error_code: 'NETWORK',
             error_message: describe(e)},
      )))));
      throw e;
    }
    await applyReceipts(db, batch, results);
  }
  return sent;
}

export async function applyReceipts(db: Database, batch: LocalRecord<QueueRow>[], results: Receipt[]): Promise<void> {
  const byId = new Map(results.map(r => [r.operation_id, r]));
  await db.write(async () => {
    const ops: Model[] = [];
    const entities: {entity: string; id: string; version: number; data: unknown}[] = [];
    for (const row of batch) {
      const r = byId.get(row.r.operation_id);
      if (!r) continue;
      const base = {result_json: JSON.stringify({...r, entities: undefined}), error_code: r.code, error_message: r.message};
      switch (r.status) {
        case 'ACCEPTED':
          ops.push(row.prepareUpdate(x => x.set({...base, state: 'ACCEPTED', next_retry_at: null})));
          entities.push(...(r.entities ?? []));
          break;
        case 'CONFLICT':
        case 'REJECTED':
          ops.push(row.prepareUpdate(x => x.set({...base, state: r.status as QueueRow['state'], next_retry_at: null})));
          entities.push(...(r.entities ?? []));
          ops.push(db.get<LocalRecord<LocalConflictRow>>('local_conflicts').prepareCreate(c => {
            Object.assign(c._raw, {
              conflict_id: (r.entities ?? []).find(e => e.entity === 'conflict')?.id ?? null,
              operation_id: r.operation_id,
              code: r.code ?? r.status,
              details_json: JSON.stringify({message: r.message, field_errors: r.field_errors, details: r.details}),
              resolution_state: 'OPEN',
            });
          }));
          break;
        case 'DEPENDENCY_PENDING':
          ops.push(row.prepareUpdate(x => x.set({...base, state: 'DEPENDENCY_WAIT', next_retry_at: Date.now() + retryDelayMs(x.r.attempts - 1)})));
          break;
        default:
          ops.push(row.prepareUpdate(x => x.set({...base, state: 'RETRY_WAIT', next_retry_at: Date.now() + retryDelayMs(x.r.attempts - 1)})));
      }
    }
    await db.batch(...ops);
    // Canonical projections from receipts replace optimistic overlays in the same transaction.
    if (entities.length) await applyEvents(db, entities);
    // Evidence uploads are authorized only for accepted parents.
    const accepted = batch.filter(b => byId.get(b.r.operation_id)?.status === 'ACCEPTED').map(b => b.r.operation_id);
    const rejected = batch.filter(b => ['CONFLICT', 'REJECTED'].includes(byId.get(b.r.operation_id)?.status ?? '')).map(b => b.r.operation_id);
    const atts = await db.get<LocalRecord<AttachmentRow>>('attachment_queue')
      .query(Q.where('operation_id', Q.oneOf([...accepted, ...rejected])), Q.where('state', 'WAITING_PARENT')).fetch();
    if (atts.length) {
      await db.batch(...atts.map(a => a.prepareUpdate(x => x.set(
        accepted.includes(x.r.operation_id)
          ? {state: 'READY_UPLOAD'}
          : {state: 'REJECTED', error: 'Inspection was not accepted; photo kept on device.'},
      ))));
    }
  });
}
