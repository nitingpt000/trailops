import type { EquipmentStatus, RepairState, TransferState } from './projections';

export type Tone = 'success' | 'info' | 'warning' | 'error' | 'neutral';

export const STATUS_LABEL: Record<EquipmentStatus, { label: string; tone: Tone; issuable: boolean }> = {
  READY: { label: 'Ready', tone: 'success', issuable: true },
  ISSUED: { label: 'Issued', tone: 'info', issuable: false },
  QUARANTINED: { label: 'Needs review', tone: 'warning', issuable: false },
  REPAIR_PENDING: { label: 'Repair requested', tone: 'warning', issuable: false },
  UNDER_REPAIR: { label: 'Under repair', tone: 'warning', issuable: false },
  IN_TRANSIT: { label: 'In transit', tone: 'neutral', issuable: false },
  MISSING: { label: 'Missing', tone: 'error', issuable: false },
  RETIRED: { label: 'Retired', tone: 'neutral', issuable: false },
};

export const REPAIR_LABEL: Record<RepairState, string> = {
  REQUESTED: 'Awaiting decision',
  MORE_INFORMATION_REQUIRED: 'More information needed',
  APPROVED: 'Approved',
  IN_PROGRESS: 'In progress',
  AWAITING_RELEASE: 'Awaiting release',
  CLOSED: 'Closed',
  DENIED: 'Denied',
};

export const TRANSFER_LABEL: Record<TransferState, string> = {
  DISPATCHED: 'In transit',
  RECEIVED: 'Received',
  DISCREPANCY: 'Discrepancy',
  RECONCILED: 'Reconciled',
};

/** Sync-state wording shown with every locally captured action (tokens.json statusLabels). */
export const SYNC_LABEL = {
  saved: 'Saved on this device',
  awaiting: 'Awaiting server confirmation',
  confirmed: 'Confirmed',
  review: 'Needs review',
} as const;
