/** Reactive reads: subscribe only to the rows a screen needs (spec §10). */
import {useEffect, useMemo, useState} from 'react';
import {Q, type Query} from '@nozbe/watermelondb';
import type {
  AllocationP, BatchMemberP, BatchP, CampP, CategoryP, ConflictP, CustodyClaimP, EquipmentP, FormDefinitionP,
  FormVersionP, InspectionP, LocationP, RepairP, TransferLineP, TransferP,
} from '@trailops/contracts';
import {useDb, useSession} from '../app/session';
import {PENDING_STATES, type AttachmentRow, type LocalRecord, type QueueRow, type SyncMetaRow, type ProjectionRecord} from './models';

export function useQuery<T>(factory: () => Query<any>, deps: unknown[], map: (rows: any[]) => T, columns?: string[]): T | undefined {
  const [value, setValue] = useState<T>();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(factory, deps);
  useEffect(() => {
    const obs = columns ? query.observeWithColumns(columns) : query.observe();
    const sub = obs.subscribe(rows => setValue(map(rows)));
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return value;
}

const data = <T,>(rows: ProjectionRecord<T>[]) => rows.map(r => r.data);
const one = <T,>(rows: ProjectionRecord<T>[]) => (rows[0] ? rows[0].data : null);

export function useProjection<T>(table: string, ...clauses: Q.Clause[]): T[] | undefined {
  const db = useDb();
  const key = JSON.stringify(clauses);
  return useQuery(() => db.get(table).query(...clauses), [table, key], rows => data<T>(rows), ['version']);
}

export function useOne<T>(table: string, serverId: string | null | undefined): T | null | undefined {
  const db = useDb();
  return useQuery(() => db.get(table).query(Q.where('server_id', serverId ?? '__none__')), [table, serverId],
    rows => one<T>(rows), ['version']);
}

export const useCamps = () => useProjection<CampP>('camps');
export const useCategories = () => useProjection<CategoryP>('categories');
export function useCampLocations(campId: string | null) {
  return useProjection<LocationP>('locations', Q.where('camp_id', campId ?? ''));
}
export const useAllLocations = () => useProjection<LocationP>('locations');
export function useCampEquipment(campId: string | null) {
  return useProjection<EquipmentP>('equipment', Q.where('camp_id', campId ?? ''), Q.sortBy('tag', Q.asc));
}
export const useItem = (id?: string | null) => useOne<EquipmentP>('equipment', id);
export function useActiveAllocation(itemId?: string | null) {
  const rows = useProjection<AllocationP>('allocations', Q.where('item_id', itemId ?? ''), Q.where('state', 'ACTIVE'));
  return rows?.[0] ?? null;
}
export function useItemInspections(itemId?: string | null) {
  return useProjection<InspectionP>('inspections', Q.where('item_id', itemId ?? ''));
}
export function useItemRepairs(itemId?: string | null) {
  return useProjection<RepairP>('repairs', Q.where('item_id', itemId ?? ''));
}
export function useCampBatches(campId: string | null) {
  return useProjection<BatchP>('batches', Q.where('camp_id', campId ?? ''));
}
export function useBatchMembers(batchId?: string | null) {
  return useProjection<BatchMemberP>('batch_members', Q.where('batch_id', batchId ?? ''));
}
export const useAllMembers = () => useProjection<BatchMemberP>('batch_members');
export const useTransfers = () => useProjection<TransferP>('transfers');
export function useTransferLines(transferId?: string | null) {
  return useProjection<TransferLineP>('transfer_lines', Q.where('transfer_id', transferId ?? ''));
}
export const useOpenConflicts = () => useProjection<ConflictP>('conflicts', Q.where('state', 'OPEN'));
export const useConflict = (id?: string | null) => useOne<ConflictP>('conflicts', id);
export function useOpenClaims(itemId?: string | null) {
  return useProjection<CustodyClaimP>('custody_claims', Q.where('item_id', itemId ?? ''), Q.where('state', 'OPEN'));
}
export const useRepairsByState = (states: string[]) => useProjection<RepairP>('repairs', Q.where('state', Q.oneOf(states)));
export const useFormDefinitions = () => useProjection<FormDefinitionP>('form_definitions');
export const useFormVersions = () => useProjection<FormVersionP>('form_versions');

/** Local intent ------------------------------------------------------------------------------- */

export function useQueue(states?: string[]): QueueRow[] | undefined {
  const db = useDb();
  const accountId = useSession(s => s.account?.accountId ?? '');
  const key = (states ?? []).join(',');
  return useQuery(
    () => db.get('command_queue').query(
      Q.where('account_id', accountId),
      ...(states ? [Q.where('state', Q.oneOf(states))] : []),
      Q.sortBy('created_seq', Q.desc),
    ),
    [accountId, key],
    (rows: LocalRecord<QueueRow>[]) => rows.map(r => r.r),
    ['state', 'attempts', 'error_code'],
  );
}

export const usePending = () => useQueue(PENDING_STATES);

export function useAttachmentQueue(): AttachmentRow[] | undefined {
  const db = useDb();
  return useQuery(() => db.get('attachment_queue').query(), [],
    (rows: LocalRecord<AttachmentRow>[]) => rows.map(r => ({...r.r})), ['state', 'attempts']);
}

export function useMeta(): SyncMetaRow | undefined {
  const db = useDb();
  const accountId = useSession(s => s.account?.accountId ?? '');
  return useQuery(() => db.get('sync_meta').query(Q.where('account_id', accountId)), [accountId],
    (rows: LocalRecord<SyncMetaRow>[]) => (rows[0] ? {...rows[0].r} : (undefined as never)),
    ['cursor', 'last_success_at', 'last_error', 'last_pull_at']);
}

/**
 * Operations needing a person's attention: rejected/conflicted commands and blocked dependents.
 * A conflicted command whose server conflict has been resolved is settled history, not an exception.
 */
export function useNeedsReview(): QueueRow[] {
  const failed = useQueue(['CONFLICT', 'REJECTED', 'DEPENDENCY_WAIT']);
  const conflicts = useProjection<ConflictP>('conflicts');
  return useMemo(() => {
    const resolved = new Set((conflicts ?? []).filter(c => c.state === 'RESOLVED').map(c => c.operation_id));
    return (failed ?? []).filter(q =>
      q.state === 'DEPENDENCY_WAIT' ? q.error_code === 'BLOCKED_BY_DEPENDENCY' : !resolved.has(q.operation_id));
  }, [failed, conflicts]);
}

/** Pending commands keyed by aggregate id, for provisional overlays. */
export function usePendingByAggregate(): Map<string, QueueRow[]> {
  const pending = usePending();
  return useMemo(() => {
    const m = new Map<string, QueueRow[]>();
    for (const p of pending ?? []) {
      if (!p.aggregate_id) continue;
      m.set(p.aggregate_id, [...(m.get(p.aggregate_id) ?? []), p]);
    }
    return m;
  }, [pending]);
}
