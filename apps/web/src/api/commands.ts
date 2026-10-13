/**
 * Console command helpers (spec §8, §18, §21). Every mutation is one Operation sent to
 * POST /v1/commands. The operation id is created once per submission and reused when the *same*
 * submission is retried after a transport failure, so the server can deduplicate it. A changed
 * submission (different payload/preconditions) always gets a fresh id: the server would otherwise
 * reject it as OPERATION_ID_REUSED.
 */
import type { CommandPayloads, CommandType, Operation, Precondition, Receipt } from '@trailops/contracts';

export interface CommandDraft<T extends CommandType = CommandType> {
  type: T;
  aggregate_id: string | null;
  expected_version?: number | null;
  preconditions?: Precondition[];
  payload: CommandPayloads[T];
}

export interface Attempt {
  operation: Operation;
  /** True once the server returned a terminal receipt (ACCEPTED / REJECTED / CONFLICT). */
  settled: boolean;
}

/** Deterministic JSON (sorted keys) so equal submissions compare equal regardless of key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function body(d: CommandDraft | Operation): string {
  return canonical({
    type: d.type,
    aggregate_id: d.aggregate_id ?? null,
    expected_version: d.expected_version ?? null,
    preconditions: d.preconditions ?? [],
    payload: d.payload,
  });
}

export function sameSubmission(op: Operation, draft: CommandDraft): boolean {
  return body(op) === body(draft);
}

/**
 * Returns the operation to send. Reuses the previous operation (same id) only when it has not
 * received a terminal receipt and the submission is unchanged; otherwise mints a new id.
 */
export function prepareOperation<T extends CommandType>(
  draft: CommandDraft<T>,
  previous: Attempt | null,
  newId: () => string = () => crypto.randomUUID(),
  now: () => Date = () => new Date(),
): Operation<T> {
  if (previous && !previous.settled && sameSubmission(previous.operation, draft)) {
    return previous.operation as Operation<T>;
  }
  const op: Operation<T> = {
    operation_id: newId(),
    type: draft.type,
    aggregate_id: draft.aggregate_id,
    payload: draft.payload,
    client_recorded_at: now().toISOString(),
  };
  if (draft.expected_version !== undefined && draft.expected_version !== null) op.expected_version = draft.expected_version;
  if (draft.preconditions && draft.preconditions.length) op.preconditions = draft.preconditions;
  return op;
}

export function isReceipt(body: unknown): body is Receipt {
  return !!body && typeof body === 'object' && 'operation_id' in body && 'status' in body;
}

export function isTerminal(r: Receipt): boolean {
  return r.status === 'ACCEPTED' || r.status === 'REJECTED' || r.status === 'CONFLICT';
}

export type Tone = 'success' | 'warning' | 'error' | 'info';

export interface ReceiptView {
  tone: Tone;
  title: string;
  message: string;
  code: string | null;
  fieldErrors: Record<string, string>;
  /** Suggest the user reloads before trying again. */
  refresh: boolean;
  retryable: boolean;
}

const CONFLICT_HINTS: Record<string, string> = {
  VERSION_CONFLICT: 'This record changed since you loaded it. Refresh, review the latest state and try again.',
  EVIDENCE_PENDING: 'Photo evidence has not been verified yet. The decision stays blocked until the photos upload and verify.',
  CUSTODY_HOLD: 'An unresolved custody claim blocks this item. Reconcile it from “Needs your attention” first.',
  CONSTRAINT_CONFLICT: 'The change conflicts with current data. Refresh and retry.',
};

/** Maps a receipt to user-facing wording. The server message is always shown; hints add context. */
export function describeReceipt(r: Receipt): ReceiptView {
  const fieldErrors = (r.field_errors ?? {}) as Record<string, string>;
  switch (r.status) {
    case 'ACCEPTED':
      return {
        tone: 'success',
        title: r.replayed ? 'Already recorded' : 'Confirmed',
        message: r.replayed
          ? 'The server had already accepted this submission; nothing was applied twice.'
          : 'The server accepted the change.',
        code: r.code,
        fieldErrors,
        refresh: false,
        retryable: false,
      };
    case 'CONFLICT': {
      const hint = r.code ? CONFLICT_HINTS[r.code] : undefined;
      // The server message is always shown; the hint is added only when it says something new.
      const redundant = r.code === 'VERSION_CONFLICT' && !!r.message && /changed since/i.test(r.message);
      const message = [r.message, hint && !redundant ? hint : null].filter(Boolean).join(' ');
      return {
        tone: 'warning',
        title: r.code === 'VERSION_CONFLICT' ? 'Changed since you loaded it' : 'Not applied — conflict',
        message: message || 'The change conflicts with the current state.',
        code: r.code,
        fieldErrors,
        refresh: r.code === 'VERSION_CONFLICT' || r.code === 'CONSTRAINT_CONFLICT',
        retryable: false,
      };
    }
    case 'REJECTED':
      return {
        tone: 'error',
        title: r.http_status === 403 ? 'Not permitted' : 'Rejected',
        message: r.message || 'The server rejected the change.',
        code: r.code,
        fieldErrors,
        refresh: false,
        retryable: false,
      };
    case 'DEPENDENCY_PENDING':
      return {
        tone: 'info',
        title: 'Waiting for an earlier operation',
        message: r.message || 'An earlier operation has not reached the server yet. Retry shortly.',
        code: r.code,
        fieldErrors,
        refresh: false,
        retryable: true,
      };
    default:
      return {
        tone: 'error',
        title: 'Temporary problem',
        message: r.message || 'The server could not process this right now. Retry — it will not be applied twice.',
        code: r.code,
        fieldErrors,
        refresh: false,
        retryable: true,
      };
  }
}

/** Formats a field-error key such as `replacement.item_id` or `fields.2.options` for display. */
export function fieldLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\./g, ' › ');
}
