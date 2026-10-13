/** Command envelope and catalogue (spec §8, §18). Mirrors services/api/app/modules/commands. */
import type { IsoDate, IsoInstant, Uuid } from './projections';

export interface Precondition {
  entity: 'equipment' | 'allocation' | 'repair' | 'transfer' | 'transfer_line' | 'conflict' | 'form_version';
  id: Uuid;
  expected_version?: number;
  after_operation_id?: Uuid;
}

export interface AttachmentDescriptor { attachment_id: Uuid; sha256: string; mime: 'image/jpeg' | 'image/png'; bytes: number }

export interface CommandPayloads {
  ISSUE_GEAR: { allocation_id: Uuid; trekker_id: Uuid; batch_id: Uuid; due_date: IsoDate; observed_location_id?: Uuid };
  SUBMIT_RETURN: {
    inspection_id: Uuid; allocation_id: Uuid; form_version_id: Uuid; answers: Record<string, unknown>;
    attachments: AttachmentDescriptor[];
  };
  APPROVE_REPAIR: { decision: 'APPROVE' | 'MORE_INFORMATION' | 'DENY'; note?: string; disposition?: 'RETIRE' | 'QUARANTINE' | 'REPAIR' };
  START_REPAIR: Record<string, never>;
  COMPLETE_REPAIR: { work_notes: string };
  RELEASE_EQUIPMENT: { inspection_id: Uuid; result: 'PASS' | 'FAIL'; notes?: string };
  RETIRE_EQUIPMENT: { reason: string };
  DISPATCH_TRANSFER: { from_location_id: Uuid; to_location_id: Uuid; item_ids: Uuid[]; note?: string };
  RECEIVE_TRANSFER: {
    lines: { item_id: Uuid; result: 'RECEIVED' | 'MISSING'; note?: string }[];
    extra_items?: { tag: string; note?: string }[];
    notes?: string;
  };
  RESOLVE_TRANSFER_DISCREPANCY: { finding: 'FOUND' | 'LOST'; location_id?: Uuid; reason: string };
  RESOLVE_CUSTODY_CLAIM: { location_id?: Uuid; note: string };
  RESOLVE_ALLOCATION_CONFLICT: {
    resolution: 'CANCEL_LOCAL_CLAIM' | 'REPLACE' | 'REASSIGN';
    note: string;
    replacement?: { item_id: Uuid; allocation_id: Uuid; due_date: IsoDate; expected_version?: number };
    reassign_allocation_id?: Uuid;
  };
  EQUIPMENT_CREATE: { category_id: Uuid; tag: string; location_id: Uuid; size?: string; notes?: string };
  EQUIPMENT_UPDATE: { size?: string; notes?: string; category_id?: Uuid };
  FORM_DRAFT_SAVE: { schema: unknown };
  FORM_PUBLISH: { expected_hash: string };
  MEMBERSHIP_UPDATE: { user_id: Uuid; camp_id: Uuid; enabled: boolean; permissions?: string[] };
}
export type CommandType = keyof CommandPayloads;

/** Commands a field device may capture offline (spec §4). */
export const OFFLINE_COMMANDS: CommandType[] = [
  'ISSUE_GEAR', 'SUBMIT_RETURN', 'DISPATCH_TRANSFER', 'RECEIVE_TRANSFER', 'RESOLVE_ALLOCATION_CONFLICT',
];

export interface Operation<T extends CommandType = CommandType> {
  operation_id: Uuid;
  type: T;
  aggregate_id: Uuid | null;
  expected_version?: number | null;
  depends_on?: Uuid[];
  preconditions?: Precondition[];
  client_recorded_at?: IsoInstant;
  payload: CommandPayloads[T];
}

export type ReceiptStatus = 'ACCEPTED' | 'REJECTED' | 'CONFLICT' | 'DEPENDENCY_PENDING' | 'RETRY';

export interface Receipt {
  operation_id: Uuid;
  status: ReceiptStatus;
  code: string | null;
  message: string | null;
  retryable: boolean;
  field_errors?: Record<string, string> | null;
  details?: Record<string, unknown> | null;
  data?: Record<string, unknown>;
  versions?: Record<string, number>;
  entities?: { entity: string; id: Uuid; version: number; data: unknown }[];
  replayed?: boolean;
  http_status?: number;
}

export interface ApiErrorBody {
  error: {
    code: string; message: string; retryable: boolean; field_errors: Record<string, string>; request_id: string | null;
    details?: Record<string, unknown>;
  };
}

/** Starting retry schedule (spec §18): ~2s, 5s, 15s, 60s, then capped at 5 min, with jitter. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const steps = [2_000, 5_000, 15_000, 60_000, 300_000];
  const base = steps[Math.min(attempt, steps.length - 1)];
  return Math.round(base * (0.8 + random() * 0.4));
}
