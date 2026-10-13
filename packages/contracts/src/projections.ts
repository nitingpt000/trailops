/**
 * Sync projections as serialized by services/api/app/core/projections.py.
 * Keep in sync with ProjectionContext.serialize; the contract test in this package checks a
 * recorded bootstrap fixture against these keys.
 */

export type Uuid = string;
export type IsoDate = string; // YYYY-MM-DD
export type IsoInstant = string;

export type EquipmentStatus =
  | 'READY'
  | 'ISSUED'
  | 'QUARANTINED'
  | 'REPAIR_PENDING'
  | 'UNDER_REPAIR'
  | 'IN_TRANSIT'
  | 'MISSING'
  | 'RETIRED';

export const EQUIPMENT_STATUSES: EquipmentStatus[] = [
  'READY', 'ISSUED', 'QUARANTINED', 'REPAIR_PENDING', 'UNDER_REPAIR', 'IN_TRANSIT', 'MISSING', 'RETIRED',
];

export interface CampP { id: Uuid; code: string; name: string; timezone: string; active: boolean; version: number }
export interface LocationP { id: Uuid; camp_id: Uuid; label: string; type: string; version: number }
export interface CategoryP {
  id: Uuid; code: string; name: string; group: string; unit: 'item' | 'pair'; inspect_on_return: boolean;
  image_key: string | null; version: number;
}
export interface EquipmentP {
  id: Uuid; tag: string; category_id: Uuid; size: string | null; status: EquipmentStatus; location_id: Uuid;
  camp_id: Uuid; notes: string | null; last_inspected_at: IsoInstant | null; version: number; updated_at: IsoInstant;
  retired: boolean;
}
export interface BatchP {
  id: Uuid; code: string; trek_name: string; camp_id: Uuid; start_date: IsoDate; end_date: IsoDate; active: boolean;
  version: number;
}
export interface BatchMemberP {
  id: Uuid; batch_id: Uuid; trekker_id: Uuid; gear_requested: string[]; display_name: string | null;
  size_hint: string | null; active: boolean;
}
export type AllocationState = 'ACTIVE' | 'RETURNED' | 'REVERSED';
export interface AllocationP {
  id: Uuid; item_id: Uuid; trekker_id: Uuid; batch_id: Uuid; issued_by: Uuid; issued_at: IsoInstant;
  due_date: IsoDate; state: AllocationState; closed_at: IsoInstant | null; version: number;
}
export type EvidenceState = 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
export interface InspectionP {
  id: Uuid; item_id: Uuid; allocation_id: Uuid | null; kind: 'RETURN' | 'RELEASE' | 'RECEIPT';
  form_version_id: Uuid | null; answers: Record<string, unknown>; condition: 'GOOD' | 'NEEDS_REPAIR' | 'UNUSABLE';
  issue_type: string | null; notes: string | null; evidence_state: EvidenceState; submitted_by: Uuid;
  submitted_at: IsoInstant; version: number;
}
export type RepairState =
  | 'REQUESTED' | 'MORE_INFORMATION_REQUIRED' | 'APPROVED' | 'IN_PROGRESS' | 'AWAITING_RELEASE' | 'CLOSED' | 'DENIED';
export interface RepairP {
  id: Uuid; item_id: Uuid; inspection_id: Uuid | null; kind: 'REPAIR' | 'DISPOSITION'; state: RepairState;
  requested_by: Uuid; approved_by: Uuid | null; decision_note: string | null; work_notes: string | null;
  created_at: IsoInstant; updated_at: IsoInstant; version: number;
}
export type TransferState = 'DISPATCHED' | 'RECEIVED' | 'DISCREPANCY' | 'RECONCILED';
export interface TransferP {
  id: Uuid; code: string; from_location_id: Uuid; to_location_id: Uuid; state: TransferState;
  carrier_note: string | null; dispatched_by: Uuid; dispatched_at: IsoInstant; received_by: Uuid | null;
  received_at: IsoInstant | null; receipt_notes: string | null; version: number;
}
export interface TransferLineP {
  id: Uuid; transfer_id: Uuid; item_id: Uuid; receipt_state: 'PENDING' | 'RECEIVED' | 'MISSING';
  discrepancy_reason: string | null; resolution: 'FOUND' | 'LOST' | null; version: number;
}
export interface CustodyClaimP {
  id: Uuid; item_id: Uuid; source_type: 'ALLOCATION_CONFLICT' | 'TRANSFER_MISSING' | 'TRANSFER_EXTRA';
  source_id: Uuid; observed_location_id: Uuid | null; description: string; state: 'OPEN' | 'RESOLVED';
  created_at: IsoInstant; version: number;
}
export interface ConflictDetails {
  item_tag: string;
  item_status: EquipmentStatus;
  message: string;
  proposed: {
    allocation_id: Uuid; trekker_id: Uuid; trekker_name: string | null; batch_id: Uuid; batch_code: string | null;
    due_date: IsoDate; observed_at: IsoInstant | null; issued_by: Uuid; issued_by_name: string;
  };
  confirmed?: { allocation_id: Uuid; issued_at: IsoInstant; trekker_name: string | null; batch_code: string | null };
}
export interface ConflictP {
  id: Uuid; operation_id: Uuid; item_id: Uuid; camp_id: Uuid; code: string; raised_by: Uuid;
  details: ConflictDetails; state: 'OPEN' | 'RESOLVED'; resolution: string | null;
  resolution_operation_id: Uuid | null; created_at: IsoInstant; version: number;
}
export interface FormDefinitionP { id: Uuid; key: string; title: string; active_version_id: Uuid | null; version: number }
export interface FormVersionP {
  id: Uuid; definition_id: Uuid; number: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  schema: import('./forms').FormSchema; schema_hash: string; published_at: IsoInstant | null; version: number;
}
export interface AttachmentP {
  id: Uuid; inspection_id: Uuid; mime: string; bytes: number;
  state: 'PENDING' | 'INITIATED' | 'UPLOADED' | 'VERIFIED' | 'REJECTED'; rejection_reason: string | null; version: number;
}

export interface EntityMap {
  camp: CampP;
  location: LocationP;
  category: CategoryP;
  equipment: EquipmentP;
  batch: BatchP;
  batch_member: BatchMemberP;
  allocation: AllocationP;
  inspection: InspectionP;
  repair: RepairP;
  transfer: TransferP;
  transfer_line: TransferLineP;
  custody_claim: CustodyClaimP;
  conflict: ConflictP;
  form_definition: FormDefinitionP;
  form_version: FormVersionP;
  attachment: AttachmentP;
}
export type EntityType = keyof EntityMap;

export interface BootstrapResponse {
  protocol_version: number;
  scope_epoch: number;
  generation: string;
  high_watermark: number;
  records: { [K in EntityType]: EntityMap[K][] };
  cursor: string;
}

export interface ChangeEvent<K extends EntityType = EntityType> {
  sequence: number;
  entity: K;
  id: Uuid;
  version: number;
  deleted: boolean;
  data: EntityMap[K] | null;
}

export interface ChangesResponse {
  protocol_version: number;
  scope_epoch: number;
  changes: ChangeEvent[];
  next_cursor: string;
  has_more: boolean;
}
