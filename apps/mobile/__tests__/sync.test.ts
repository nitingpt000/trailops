/**
 * Queue + projection adapter + receipt handling against WatermelonDB's in-memory Loki adapter.
 * (Device persistence across restarts is covered by the on-device check in docs/compatibility.md.)
 */
import {Database, Q} from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import {modelClasses, type LocalRecord, type ProjectionRecord, type QueueRow} from '../src/database/models';
import {schema} from '../src/database/schema';
import {applyEvents, replaceSnapshot} from '../src/sync/projectionAdapter';
import {enqueue, markReviewed, pendingQuery} from '../src/sync/queue';
import {applyReceipts} from '../src/sync/coordinator';

jest.mock('react-native-keychain', () => ({}));
jest.mock('react-native-app-auth', () => ({}));
jest.mock('react-native-blob-util', () => ({fs: {dirs: {DocumentDir: '/tmp'}}}));
jest.mock('../src/sync/attachments', () => ({uploadReadyAttachments: jest.fn()}));

let n = 0;
function makeDb() {
  const adapter = new LokiJSAdapter({schema, useWebWorker: false, useIncrementalIndexedDB: false, dbName: `t${n++}`});
  return new Database({adapter, modelClasses});
}
const item = (status: string, version: number) => ({
  entity: 'equipment',
  id: 'item-1',
  version,
  data: {id: 'item-1', tag: 'JKT-014', status, camp_id: 'camp-1', location_id: 'loc-1', category_id: 'cat-1', version},
});
const eq = async (db: Database) =>
  (await db.get<ProjectionRecord<{status: string}>>('equipment').query(Q.where('server_id', 'item-1')).fetch())[0];
const issue = (agg: string) => ({
  type: 'ISSUE_GEAR' as const,
  aggregate_id: agg,
  summary: `Issue ${agg}`,
  payload: {allocation_id: `al-${agg}`, trekker_id: 't', batch_id: 'b', due_date: '2026-10-15'},
});
const queueRows = async (db: Database) => db.get<LocalRecord<QueueRow>>('command_queue').query().fetch();

describe('projection adapter', () => {
  it('ignores older versions and keeps the newest', async () => {
    const db = makeDb();
    await db.write(() => applyEvents(db, [item('ISSUED', 3)]));
    await db.write(() => applyEvents(db, [item('READY', 2)]));
    expect((await eq(db)).data.status).toBe('ISSUED');
    await db.write(() => applyEvents(db, [item('QUARANTINED', 4)]));
    expect((await eq(db)).data.status).toBe('QUARANTINED');
  });

  it('tombstones block stale resurrection but newer versions return', async () => {
    const db = makeDb();
    await db.write(() => applyEvents(db, [item('READY', 2)]));
    await db.write(() => applyEvents(db, [{entity: 'equipment', id: 'item-1', version: 3, deleted: true, data: null}]));
    expect(await eq(db)).toBeUndefined();
    await db.write(() => applyEvents(db, [item('READY', 2)])); // stale receipt
    expect(await eq(db)).toBeUndefined();
    await db.write(() => applyEvents(db, [item('READY', 5)])); // moved back into scope
    expect((await eq(db)).data.status).toBe('READY');
  });

  it('collapses several events for one entity in a page to the newest', async () => {
    const db = makeDb();
    await db.write(() => applyEvents(db, [item('READY', 1)]));
    await db.write(() => applyEvents(db, [item('ISSUED', 2), item('QUARANTINED', 3), item('REPAIR_PENDING', 4)]));
    expect((await eq(db)).data.status).toBe('REPAIR_PENDING');
    const fresh = makeDb();
    await fresh.write(() => applyEvents(fresh, [item('ISSUED', 2), item('READY', 3)]));
    expect((await eq(fresh)).data.status).toBe('READY');
  });

  it('snapshot replacement never touches the command queue', async () => {
    const db = makeDb();
    await enqueue(db, {accountId: 'a', deviceId: 'd'}, issue('item-1'));
    await db.write(() => applyEvents(db, [item('READY', 1)]));
    await db.write(() => replaceSnapshot(db, {equipment: [item('ISSUED', 7).data as never]}));
    expect((await eq(db)).data.status).toBe('ISSUED');
    expect(await pendingQuery(db, 'a').fetchCount()).toBe(1);
  });
});

describe('receipts', () => {
  it('accepts, records conflicts, applies canonical projections', async () => {
    const db = makeDb();
    const a = await enqueue(db, {accountId: 'a', deviceId: 'd'}, issue('item-1'));
    const b = await enqueue(db, {accountId: 'a', deviceId: 'd'}, issue('item-2'));
    await applyReceipts(db, await queueRows(db), [
      {operation_id: a, status: 'ACCEPTED', code: null, message: null, retryable: false, entities: [item('ISSUED', 2)]},
      {operation_id: b, status: 'CONFLICT', code: 'ITEM_ALREADY_ALLOCATED', message: 'taken', retryable: false, entities: []},
    ]);
    const after = Object.fromEntries((await queueRows(db)).map(r => [r.r.operation_id, r.r]));
    expect(after[a].state).toBe('ACCEPTED');
    expect(after[b].state).toBe('CONFLICT');
    expect((await eq(db)).data.status).toBe('ISSUED');
    expect(await db.get('local_conflicts').query().fetchCount()).toBe(1);
  });

  it('transient results stay retryable and are never dropped', async () => {
    const db = makeDb();
    const a = await enqueue(db, {accountId: 'a', deviceId: 'd'}, {
      type: 'RECEIVE_TRANSFER', aggregate_id: 'tr', summary: 'Receive', payload: {lines: [{item_id: 'i', result: 'RECEIVED'}]},
    });
    const rows = await queueRows(db);
    await db.write(() => rows[0].update(r => r.set({attempts: 1})));
    await applyReceipts(db, rows, [
      {operation_id: a, status: 'DEPENDENCY_PENDING', code: 'DEPENDENCY_PENDING', message: 'wait', retryable: true},
    ]);
    const r = (await queueRows(db))[0].r;
    expect(r.state).toBe('DEPENDENCY_WAIT');
    expect(r.next_retry_at).toBeGreaterThan(Date.now());
    expect(await pendingQuery(db, 'a').fetchCount()).toBe(1);
  });

  it('marking a rejected operation reviewed keeps it as history', async () => {
    const db = makeDb();
    const a = await enqueue(db, {accountId: 'a', deviceId: 'd'}, issue('item-1'));
    await applyReceipts(db, await queueRows(db), [
      {operation_id: a, status: 'REJECTED', code: 'FORBIDDEN', message: 'no', retryable: false},
    ]);
    await markReviewed(db, a);
    const lc = await db.get<LocalRecord<{resolution_state: string}>>('local_conflicts').query().fetch();
    expect(lc.map(r => r.r.resolution_state)).toEqual(['RESOLVED']);
    expect((await queueRows(db))[0].r.state).toBe('REJECTED'); // never deleted
  });

  it('payload is hashed and stored at creation', async () => {
    const db = makeDb();
    await enqueue(db, {accountId: 'a', deviceId: 'd'}, issue('item-1'));
    const r = (await queueRows(db))[0].r;
    expect(r.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.payload_json).allocation_id).toBe('al-item-1');
  });
});
