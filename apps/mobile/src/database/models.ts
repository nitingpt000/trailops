import {Model} from '@nozbe/watermelondb';
import {PROJECTIONS} from './schema';

/**
 * Projection rows expose the parsed server projection. Writes happen only in the projection adapter,
 * which sets raw columns directly inside database.write().
 */
export class ProjectionRecord<T = Record<string, unknown>> extends Model {
  get serverId(): string {
    return this._raw.server_id as unknown as string;
  }
  get version(): number {
    return this._raw.version as unknown as number;
  }
  get data(): T {
    // Parsed lazily and cached per raw json string.
    const raw = (this._raw as unknown as {json: string}).json;
    if (this._cacheKey !== raw) {
      this._cache = JSON.parse(raw) as T;
      this._cacheKey = raw;
    }
    return this._cache as T;
  }
  private _cache: T | undefined;
  private _cacheKey: string | undefined;
}

/** Local intent rows (queue, drafts, attachments, meta, conflicts) with typed raw access. */
export class LocalRecord<T = Record<string, unknown>> extends Model {
  get r(): T {
    return this._raw as unknown as T;
  }
  set(values: Partial<T>): void {
    for (const [k, v] of Object.entries(values)) this._setRaw(k, v as never);
  }
}

function make<B extends typeof Model>(Base: B, table: string): B {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const C = class extends (Base as typeof Model) {
    static table = table;
  };
  Object.defineProperty(C, 'name', {value: `${table}_model`});
  return C as unknown as B;
}

export const modelClasses = [
  ...Object.values(PROJECTIONS).map(p => make(ProjectionRecord, p.table)),
  ...['command_queue', 'drafts', 'attachment_queue', 'sync_meta', 'local_conflicts', 'tombstones'].map(t => make(LocalRecord, t)),
];

export interface QueueRow {
  operation_id: string;
  account_id: string;
  device_id: string;
  type: string;
  aggregate_id: string | null;
  payload_json: string;
  payload_hash: string;
  expected_version: number | null;
  depends_on_json: string;
  preconditions_json: string;
  client_recorded_at: string;
  state: QueueState;
  attempts: number;
  next_retry_at: number | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  summary: string;
  created_seq: number;
  first_sent_at: number | null;
}

export type QueueState =
  | 'QUEUED'
  | 'SENDING'
  | 'ACCEPTED'
  | 'CONFLICT'
  | 'REJECTED'
  | 'RETRY_WAIT'
  | 'AUTH_BLOCKED'
  | 'DEPENDENCY_WAIT';

export const PENDING_STATES: QueueState[] = ['QUEUED', 'SENDING', 'RETRY_WAIT', 'AUTH_BLOCKED', 'DEPENDENCY_WAIT'];

export interface AttachmentRow {
  attachment_id: string;
  operation_id: string;
  inspection_id: string;
  private_file_path: string;
  hash: string;
  mime: string;
  bytes: number;
  state: 'CAPTURED' | 'WAITING_PARENT' | 'READY_UPLOAD' | 'UPLOADING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED';
  attempts: number;
  next_retry_at: number | null;
  error: string | null;
}

export interface SyncMetaRow {
  account_id: string;
  scope_epoch: number | null;
  cursor: string | null;
  bootstrap_generation: string | null;
  schema_version: number;
  last_success_at: number | null;
  last_pull_at: number | null;
  last_push_at: number | null;
  me_json: string | null;
  last_verified_at: number | null;
  camp_id: string | null;
  last_error: string | null;
}

export interface DraftRow {
  owner_id: string;
  screen_key: string;
  entity_id: string | null;
  form_version_id: string | null;
  values_json: string;
  saved_at: number;
}

export interface LocalConflictRow {
  conflict_id: string | null;
  operation_id: string;
  code: string;
  details_json: string;
  resolution_state: 'OPEN' | 'RESOLVED';
}
