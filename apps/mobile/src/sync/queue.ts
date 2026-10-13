/**
 * Durable command queue (spec §7, §18).
 *
 * A user action is "saved" only after its command row (and any attachment rows / draft cleanup)
 * commits in one database.write(). The payload is immutable after creation: corrections create a new
 * operation. Displayed state = confirmed projection + pending overlays computed from this table.
 */
import {Q, type Database, type Model} from '@nozbe/watermelondb';
import type {CommandPayloads, CommandType, Precondition} from '@trailops/contracts';
import {PENDING_STATES, type LocalConflictRow, type LocalRecord, type QueueRow} from '../database/models';
import {canonicalJson, sha256Hex, uuid} from '../native/sha256';

export interface NewCommand<T extends CommandType = CommandType> {
  type: T;
  aggregate_id: string | null;
  payload: CommandPayloads[T];
  expected_version?: number | null;
  depends_on?: string[];
  preconditions?: Precondition[];
  summary: string;
  operation_id?: string;
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() * 1000 + seqCounter;
}

export function payloadHash(cmd: Pick<NewCommand, 'type' | 'aggregate_id' | 'payload'>): string {
  return sha256Hex(canonicalJson({type: cmd.type, aggregate_id: cmd.aggregate_id, payload: cmd.payload}));
}

/**
 * Persist a command plus related local rows atomically. `extra` prepares additional records (e.g.
 * attachment queue rows, draft deletion) in the same transaction.
 */
export async function enqueue(
  db: Database,
  ctx: {accountId: string; deviceId: string | null},
  cmd: NewCommand,
  extra?: (operationId: string) => Promise<Model[]> | Model[],
): Promise<string> {
  const operationId = cmd.operation_id ?? uuid();
  await db.write(async () => {
    const row = db.get<LocalRecord<QueueRow>>('command_queue').prepareCreate(r => {
      const raw: QueueRow = {
        operation_id: operationId,
        account_id: ctx.accountId,
        device_id: ctx.deviceId ?? '',
        type: cmd.type,
        aggregate_id: cmd.aggregate_id,
        payload_json: JSON.stringify(cmd.payload),
        payload_hash: payloadHash(cmd),
        expected_version: cmd.expected_version ?? null,
        depends_on_json: JSON.stringify(cmd.depends_on ?? []),
        preconditions_json: JSON.stringify(cmd.preconditions ?? []),
        client_recorded_at: new Date().toISOString(),
        state: 'QUEUED',
        attempts: 0,
        next_retry_at: null,
        result_json: null,
        error_code: null,
        error_message: null,
        summary: cmd.summary,
        created_seq: nextSeq(),
        first_sent_at: null,
      };
      Object.assign(r._raw, raw);
    });
    const more = extra ? await extra(operationId) : [];
    await db.batch(row, ...more);
  });
  return operationId;
}

export function queueTable(db: Database) {
  return db.get<LocalRecord<QueueRow>>('command_queue');
}

export function pendingQuery(db: Database, accountId: string) {
  return queueTable(db).query(
    Q.where('account_id', accountId),
    Q.where('state', Q.oneOf(PENDING_STATES)),
    Q.sortBy('created_seq', Q.asc),
  );
}

export function payloadOf<T extends CommandType>(row: QueueRow): CommandPayloads[T] {
  return JSON.parse(row.payload_json) as CommandPayloads[T];
}

/** Most recent pending operation for an aggregate — used for "Provisional" overlays. */
export async function pendingFor(db: Database, accountId: string, aggregateId: string): Promise<QueueRow[]> {
  const rows = await queueTable(db)
    .query(
      Q.where('account_id', accountId),
      Q.where('aggregate_id', aggregateId),
      Q.where('state', Q.oneOf(PENDING_STATES)),
      Q.sortBy('created_seq', Q.asc),
    )
    .fetch();
  return rows.map(r => r.r);
}

/**
 * A person acknowledges a rejected/conflicted operation. The command row and its receipt stay as
 * history (never deleted); only the "needs review" alert is cleared.
 */
export async function markReviewed(db: Database, operationId: string): Promise<void> {
  const table = db.get<LocalRecord<LocalConflictRow>>('local_conflicts');
  const rows = await table.query(Q.where('operation_id', operationId)).fetch();
  await db.write(async () => {
    if (rows.length) {
      await db.batch(...rows.map(r => r.prepareUpdate(x => x.set({resolution_state: 'RESOLVED'}))));
    } else {
      await table.create(r => {
        Object.assign(r._raw, {conflict_id: null, operation_id: operationId, code: 'REVIEWED', details_json: '{}',
          resolution_state: 'RESOLVED'});
      });
    }
  });
}
