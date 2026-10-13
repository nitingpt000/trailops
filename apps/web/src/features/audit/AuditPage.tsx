import { Fragment, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { useAudit, useUsers, type AuditFilters } from '../../api/queries';
import { useSession } from '../../app/session';
import { Button, EmptyState, ErrorState, fmtDateTime, Spinner, shortId } from '../../ui/kit';
import { AuditDiff } from './AuditDiff';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function AuditPage() {
  const { can } = useSession();
  const users = useUsers(can('audit.read', null) || can('access.manage', null));
  const [form, setForm] = useState({ aggregate_id: '', operation_id: '', actor_id: '', event_type: '', since: '', until: '' });
  const [filters, setFilters] = useState<AuditFilters>({});
  const [open, setOpen] = useState<Set<number>>(new Set());
  const invalid = {
    aggregate_id: form.aggregate_id && !UUID.test(form.aggregate_id.trim()) ? 'Must be a UUID' : null,
    operation_id: form.operation_id && !UUID.test(form.operation_id.trim()) ? 'Must be a UUID' : null,
  };
  const audit = useAudit(filters, true);
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];

  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (invalid.aggregate_id || invalid.operation_id) return;
    setFilters({
      aggregate_id: form.aggregate_id.trim() || undefined,
      operation_id: form.operation_id.trim() || undefined,
      actor_id: form.actor_id || undefined,
      event_type: form.event_type.trim().toUpperCase() || undefined,
      since: toIso(form.since),
      until: toIso(form.until),
    });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Audit trail</h1>
          <p className="page-sub">
            Append-only record of every command: server-authenticated actor, operation id, before/after, and the separate device
            observation time.
          </p>
        </div>
      </div>
      <form className="panel audit-filters" onSubmit={apply} aria-label="Audit filters">
        <label className="filter">
          <span>Item / aggregate id</span>
          <input className="input" value={form.aggregate_id} onChange={set('aggregate_id')} placeholder="UUID" aria-invalid={!!invalid.aggregate_id || undefined} />
          {invalid.aggregate_id && <span className="error-text small">{invalid.aggregate_id}</span>}
        </label>
        <label className="filter">
          <span>Operation id</span>
          <input className="input" value={form.operation_id} onChange={set('operation_id')} placeholder="UUID" aria-invalid={!!invalid.operation_id || undefined} />
          {invalid.operation_id && <span className="error-text small">{invalid.operation_id}</span>}
        </label>
        <label className="filter">
          <span>Actor</span>
          <select className="input" value={form.actor_id} onChange={set('actor_id')}>
            <option value="">Anyone</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Event type</span>
          <input className="input" value={form.event_type} onChange={set('event_type')} placeholder="e.g. ISSUED, RELEASED" list="event-types" />
          <datalist id="event-types">
            {['CREATED', 'ISSUED', 'RETURNED', 'RELEASED', 'RETIRED', 'DISPATCHED', 'RECEIVED', 'HANDOVER_MISSING', 'PUBLISHED', 'DRAFT_SAVED', 'RAISED', 'RESOLVED', 'CAMP_ACCESS_CHANGED'].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="filter">
          <span>From</span>
          <input className="input" type="datetime-local" value={form.since} onChange={set('since')} />
        </label>
        <label className="filter">
          <span>Until</span>
          <input className="input" type="datetime-local" value={form.until} onChange={set('until')} />
        </label>
        <div className="filter-actions">
          <Button type="submit" variant="primary">
            Apply filters
          </Button>
          <Button
            onClick={() => {
              setForm({ aggregate_id: '', operation_id: '', actor_id: '', event_type: '', since: '', until: '' });
              setFilters({});
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      {audit.error && <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />}
      {audit.isLoading && <Spinner label="Loading audit events" />}
      {audit.data && rows.length === 0 && <EmptyState icon={<History size={32} aria-hidden />} title="No matching events" />}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table audit-table">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Expand</span></th>
                <th scope="col">Server time</th>
                <th scope="col">Actor</th>
                <th scope="col">Command / event</th>
                <th scope="col">Summary</th>
                <th scope="col" className="hide-md">Operation</th>
                <th scope="col" className="hide-md">Device observed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const expanded = open.has(e.id);
                return (
                  <Fragment key={e.id}>
                    <tr>
                      <td>
                        <button className="icon-btn sm" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} changes for event ${e.id}`} onClick={() => toggle(e.id)}>
                          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        </button>
                      </td>
                      <td className="nowrap">{fmtDateTime(e.recorded_at)}</td>
                      <td>{e.actor_name ?? <span className="muted">System</span>}</td>
                      <td>
                        <strong className="mono-sm">{e.command_type ?? '—'}</strong>
                        <span className="muted small block">
                          {e.event_type} · {e.aggregate_type}
                          {e.aggregate_version != null && ` v${e.aggregate_version}`}
                        </span>
                      </td>
                      <td>{e.summary ?? <span className="muted">—</span>}</td>
                      <td className="hide-md">
                        {e.operation_id ? (
                          <button className="link-btn mono-sm" title={e.operation_id} onClick={() => { setForm((f) => ({ ...f, operation_id: e.operation_id! })); setFilters({ operation_id: e.operation_id! }); }}>
                            {shortId(e.operation_id)}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="hide-md nowrap">
                        {e.client_recorded_at ? fmtDateTime(e.client_recorded_at) : <span className="muted">—</span>}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="audit-detail">
                        <td />
                        <td colSpan={6}>
                          <div className="audit-meta small">
                            <span>Aggregate <code>{e.aggregate_id}</code></span>
                            {e.operation_id && <span>Operation <code>{e.operation_id}</code></span>}
                            {e.request_id && <span>Request <code>{e.request_id}</code></span>}
                            <span>Server {e.recorded_at}</span>
                            <span>Device {e.client_recorded_at ?? 'not supplied'}</span>
                          </div>
                          <AuditDiff before={e.before} after={e.after} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {audit.hasNextPage && (
        <div className="table-foot">
          <Button onClick={() => void audit.fetchNextPage()} pending={audit.isFetchingNextPage}>
            Load older events
          </Button>
        </div>
      )}
    </div>
  );
}
