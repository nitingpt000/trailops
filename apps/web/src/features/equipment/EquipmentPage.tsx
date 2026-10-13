import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Package, Plus, Search, Truck, TriangleAlert, Wrench } from 'lucide-react';
import { EQUIPMENT_STATUSES, STATUS_LABEL, type EquipmentStatus } from '@trailops/contracts';
import { useCategories, useEquipmentList } from '../../api/queries';
import type { EquipmentRow } from '../../api/types';
import { useSession } from '../../app/session';
import { Avatar, Button, DateTimeCell, EmptyState, ErrorState, Spinner, StatusBadge } from '../../ui/kit';
import { AttentionPanel } from './AttentionPanel';
import { EquipmentDrawer } from './EquipmentDrawer';
import { AddEquipmentDialog } from './AddEquipmentDialog';

export const campShort = (name: string | undefined) => (name ?? '').replace(/ base camp$/i, '');

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function LocationCell({ row }: { row: EquipmentRow }) {
  if (row.open_conflicts > 0) {
    return (
      <span className="loc-cell loc-alert">
        <TriangleAlert size={16} aria-hidden /> Allocation conflict
      </span>
    );
  }
  if (row.allocation) {
    return (
      <span className="loc-cell">
        <Avatar name={row.allocation.trekker_name} />
        <span>
          <strong>{row.allocation.trekker_name}</strong>
          <span className="muted small block">{row.allocation.trek_name}</span>
        </span>
      </span>
    );
  }
  if (row.status === 'IN_TRANSIT') {
    return (
      <span className="loc-cell">
        <Truck size={18} aria-hidden />
        <span>
          In transit
          <span className="muted small block">from {row.location.label}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="loc-cell">
      {row.location.label}
      {row.open_claims > 0 && (
        <span className="loc-alert small">
          <TriangleAlert size={14} aria-hidden /> custody claim
        </span>
      )}
    </span>
  );
}

const TILES: { key: string; label: string; statuses: EquipmentStatus[]; icon: typeof Check; tone: string }[] = [
  { key: 'ready', label: 'Ready', statuses: ['READY'], icon: Check, tone: 'success' },
  { key: 'issued', label: 'Issued', statuses: ['ISSUED'], icon: ArrowRight, tone: 'info' },
  { key: 'repair', label: 'Repair', statuses: ['REPAIR_PENDING', 'UNDER_REPAIR'], icon: Wrench, tone: 'orange' },
];

export function EquipmentPage() {
  const { camp, can } = useSession();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const status = params.get('status') ?? '';
  const categoryId = params.get('category') ?? '';
  const selected = params.get('item');
  const [adding, setAdding] = useState(false);
  const categories = useCategories();

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: k !== 'item' });
  };

  const filters = useMemo(
    () => ({ camp_id: camp?.id, status: status || undefined, category_id: categoryId || undefined, q: dq || undefined }),
    [camp?.id, status, categoryId, dq],
  );
  const list = useEquipmentList(filters, !!camp);
  const firstPage = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = firstPage?.status_counts ?? {};
  const others = (['QUARANTINED', 'IN_TRANSIT', 'MISSING', 'RETIRED'] as EquipmentStatus[]).filter((s) => counts[s]);

  return (
    <div className="page page-with-aside">
      <div className="page-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">Equipment at {campShort(camp?.name)}</h1>
            <p className="page-sub">Manage and track every tagged item at the base location. One row is one asset.</p>
          </div>
          {can('equipment.manage') && (
            <Button variant="primary" icon={<Plus size={20} aria-hidden />} onClick={() => setAdding(true)}>
              Add equipment
            </Button>
          )}
        </div>

        <div className="tiles" role="group" aria-label="Status summary">
          {TILES.map((t) => {
            const n = t.statuses.reduce((a, s) => a + (counts[s] ?? 0), 0);
            const value = t.statuses.join(',');
            const active = status === value;
            return (
              <button
                key={t.key}
                className={`tile ${active ? 'tile-active' : ''}`}
                aria-pressed={active}
                onClick={() => setParam('status', active ? null : value)}
              >
                <span className={`tile-icon tile-${t.tone}`}>
                  <t.icon size={24} aria-hidden />
                </span>
                <span>
                  <span className="tile-label">{t.label}</span>
                  <span className="tile-value">{firstPage ? n : '–'}</span>
                </span>
              </button>
            );
          })}
        </div>
        {others.length > 0 && (
          <p className="muted small tile-others">
            Also:{' '}
            {others.map((s, i) => (
              <span key={s}>
                {i > 0 && ' · '}
                <button className="link-btn" onClick={() => setParam('status', s)}>
                  {STATUS_LABEL[s].label} {counts[s]}
                </button>
              </span>
            ))}
          </p>
        )}

        <div className="filters">
          <label className="search">
            <Search size={20} aria-hidden />
            <span className="sr-only">Search equipment</span>
            <input
              type="search"
              placeholder="Search by tag, name or category…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={60}
            />
          </label>
          <label className="filter">
            <span>Category</span>
            <select className="input" value={categoryId} onChange={(e) => setParam('category', e.target.value || null)}>
              <option value="">All categories</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span>Status</span>
            <select className="input" value={status} onChange={(e) => setParam('status', e.target.value || null)}>
              <option value="">All status</option>
              {EQUIPMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s].label}
                </option>
              ))}
              {!EQUIPMENT_STATUSES.includes(status as EquipmentStatus) && status && <option value={status}>Repair (all)</option>}
            </select>
          </label>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Spinner label="Loading equipment" />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Package size={32} aria-hidden />} title="No equipment matches">
            Try clearing the search or filters.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Equipment items. Select a tag to open details.</caption>
              <thead>
                <tr>
                  <th scope="col">Tag</th>
                  <th scope="col">Item</th>
                  <th scope="col" className="hide-md">Category</th>
                  <th scope="col" className="hide-md">Size</th>
                  <th scope="col">Status</th>
                  <th scope="col">Current location / person</th>
                  <th scope="col" className="hide-md">Last updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`row-click ${selected === r.id ? 'row-selected' : ''}`}
                    onClick={() => setParam('item', r.id)}
                  >
                    <td>
                      <button
                        className="tag-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setParam('item', r.id);
                        }}
                        aria-label={`Open ${r.tag} details`}
                      >
                        {r.tag}
                      </button>
                    </td>
                    <td>{r.category.name}</td>
                    <td className="hide-md">{r.category.group}</td>
                    <td className="hide-md">{r.size ?? '—'}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <LocationCell row={r} />
                    </td>
                    <td className="hide-md">
                      <DateTimeCell iso={r.updated_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {firstPage && (
          <div className="table-foot">
            <span className="muted small">
              Showing {rows.length} of {firstPage.total} items
            </span>
            {list.hasNextPage && (
              <Button onClick={() => void list.fetchNextPage()} pending={list.isFetchingNextPage}>
                Load more
              </Button>
            )}
          </div>
        )}
      </div>
      <AttentionPanel />
      {selected && <EquipmentDrawer id={selected} onClose={() => setParam('item', null)} />}
      {adding && <AddEquipmentDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
