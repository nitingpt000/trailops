/**
 * Displayed equipment state = confirmed projection + applicable pending commands (spec §7).
 * A pending issue is provisional even if the physical item was handed over; it never changes the
 * confirmed status shown next to it.
 */
import {useMemo} from 'react';
import type {CategoryP, EquipmentP, LocationP} from '@trailops/contracts';
import type {QueueRow} from '../../database/models';
import {useAllLocations, useCategories, usePendingByAggregate} from '../../database/hooks';

export type Overlay =
  | {kind: 'provisional-issue'; op: QueueRow; trekkerName: string; allocationId: string}
  | {kind: 'provisional-return'; op: QueueRow; condition: string}
  | {kind: 'provisional-dispatch'; op: QueueRow}
  | {kind: 'provisional-receipt'; op: QueueRow}
  | {kind: 'blocked'; op: QueueRow};

export interface ItemView {
  item: EquipmentP;
  category: CategoryP | undefined;
  location: LocationP | undefined;
  overlays: Overlay[];
  /** true when local pending work forbids another local issue of this item */
  locallyBusy: boolean;
}

export function overlaysFor(ops: QueueRow[] | undefined): Overlay[] {
  const out: Overlay[] = [];
  for (const op of ops ?? []) {
    const p = JSON.parse(op.payload_json);
    if (op.error_code === 'BLOCKED_BY_DEPENDENCY') out.push({kind: 'blocked', op});
    else if (op.type === 'ISSUE_GEAR') {
      out.push({kind: 'provisional-issue', op, trekkerName: op.summary.replace(/^Issue .*? to /, ''), allocationId: p.allocation_id});
    } else if (op.type === 'SUBMIT_RETURN') out.push({kind: 'provisional-return', op, condition: p.answers?.condition});
    else if (op.type === 'DISPATCH_TRANSFER') out.push({kind: 'provisional-dispatch', op});
    else if (op.type === 'RECEIVE_TRANSFER') out.push({kind: 'provisional-receipt', op});
  }
  return out;
}

export function useItemViews(items: EquipmentP[] | undefined): ItemView[] | undefined {
  const cats = useCategories();
  const locs = useAllLocations();
  const pending = usePendingByAggregate();
  return useMemo(() => {
    if (!items || !cats || !locs) return undefined;
    const c = new Map(cats.map(x => [x.id, x]));
    const l = new Map(locs.map(x => [x.id, x]));
    return items.map(item => {
      const overlays = overlaysFor(pending.get(item.id));
      // Pending dispatches/receipts are keyed by transfer id; an item's issue/return are keyed by item.
      return {
        item,
        category: c.get(item.category_id),
        location: l.get(item.location_id),
        overlays,
        locallyBusy: overlays.length > 0,
      };
    });
  }, [items, cats, locs, pending]);
}

export function itemTitle(v: Pick<ItemView, 'category'>): string {
  return v.category?.name ?? 'Equipment';
}

/** Latest provisional issue → the allocation a return should reference while offline. */
export function provisionalIssue(v: ItemView) {
  const issues = v.overlays.filter(o => o.kind === 'provisional-issue');
  const returned = v.overlays.some(o => o.kind === 'provisional-return');
  return !returned && issues.length ? (issues[issues.length - 1] as Extract<Overlay, {kind: 'provisional-issue'}>) : null;
}
