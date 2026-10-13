/** Read-endpoint shapes exactly as returned by services/api/app/modules/reads.py. */
import type {
  ConflictP,
  CustodyClaimP,
  EquipmentStatus,
  FormSchema,
  InspectionP,
  RepairP,
  RepairState,
  TransferState,
  Uuid,
} from '@trailops/contracts';

export interface MeCamp {
  id: Uuid;
  code: string;
  name: string;
  timezone: string;
  extra_permissions: string[];
}
export interface Me {
  user: { id: Uuid; display_name: string; email: string | null };
  org_id: Uuid;
  role: string;
  permissions: string[];
  org_wide: boolean;
  camps: MeCamp[];
  scope_epoch: number;
  offline_allowance_hours: number;
  server_time: string;
}

export interface CampWithLocations {
  id: Uuid;
  code: string;
  name: string;
  timezone: string;
  locations: { id: Uuid; label: string; type: string }[];
}
export interface OrgLocation {
  id: Uuid;
  label: string;
  camp_id: Uuid;
  camp_name: string;
}
export interface Category {
  id: Uuid;
  code: string;
  name: string;
  group: string;
  unit: string;
  image_key: string | null;
}

export interface EquipmentRow {
  id: Uuid;
  tag: string;
  status: EquipmentStatus;
  size: string | null;
  version: number;
  category: { id: Uuid; name: string; group: string; code: string; image_key: string | null };
  location: { id: Uuid; label: string; camp_id: Uuid; camp_name: string };
  allocation: { id: Uuid; trekker_name: string; batch_code: string; trek_name: string; due_date: string } | null;
  open_claims: number;
  open_conflicts: number;
  updated_at: string;
}
export interface EquipmentList {
  items: EquipmentRow[];
  total: number;
  status_counts: Partial<Record<EquipmentStatus, number>>;
  next_cursor: string | null;
}
export interface EquipmentDetail extends EquipmentRow {
  repair: RepairP | null;
  last_inspection: InspectionP | null;
  custody_claims: CustodyClaimP[];
  notes: string | null;
}

export interface AuditRow {
  id: number;
  aggregate_type: string;
  aggregate_id: Uuid;
  aggregate_version: number | null;
  event_type: string;
  summary: string | null;
  actor_id: Uuid | null;
  actor_name: string | null;
  operation_id: Uuid | null;
  command_type: string | null;
  request_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  recorded_at: string;
  client_recorded_at: string | null;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface TransferLineRow {
  id: Uuid;
  item_id: Uuid;
  tag: string;
  receipt_state: 'PENDING' | 'RECEIVED' | 'MISSING';
  discrepancy_reason: string | null;
  resolution: 'FOUND' | 'LOST' | null;
}
export interface TransferRow {
  id: Uuid;
  code: string;
  state: TransferState;
  version: number;
  from: { id: Uuid; label: string };
  to: { id: Uuid; label: string };
  dispatched_at: string;
  received_at: string | null;
  carrier_note: string | null;
  receipt_notes: string | null;
  lines: TransferLineRow[];
}

export type EvidenceState = 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
export interface RepairRow {
  id: Uuid;
  state: RepairState;
  kind: 'REPAIR' | 'DISPOSITION';
  version: number;
  item: { id: Uuid; tag: string; status: EquipmentStatus; version: number };
  inspection: {
    id: Uuid;
    condition: 'GOOD' | 'NEEDS_REPAIR' | 'UNUSABLE';
    issue_type: string | null;
    notes: string | null;
    evidence_state: EvidenceState;
    submitted_at: string;
    submitted_by: string | null;
    attachments: { id: Uuid; state: string; reason: string | null }[];
  } | null;
  /** Trekker who had the item when it was returned (from the closed allocation). */
  issued_to: { trekker_name: string; batch_code: string } | null;
  requested_by: string | null;
  decision_note: string | null;
  work_notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ConflictRow = ConflictP & { item_tag: string };
export type ClaimRow = CustodyClaimP & { item_tag: string };
export interface ConflictsResponse {
  conflicts: ConflictRow[];
  custody_claims: ClaimRow[];
}

export interface DeviceRow {
  id: Uuid;
  user: string;
  platform: string;
  label: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  reported_pending: number | null;
  reported_pending_at: string | null;
}

export interface FormVersionRow {
  id: Uuid;
  number: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  schema: FormSchema;
  schema_hash: string;
  version: number;
  published_at: string | null;
}
export interface FormDefinitionRow {
  id: Uuid;
  key: string;
  title: string;
  version: number;
  active_version_id: Uuid | null;
  versions: FormVersionRow[];
}

export interface UserRow {
  id: Uuid;
  display_name: string;
  email: string | null;
  role: string;
  enabled: boolean;
  camps: { camp_id: Uuid; enabled: boolean; permissions: string[] }[];
}
