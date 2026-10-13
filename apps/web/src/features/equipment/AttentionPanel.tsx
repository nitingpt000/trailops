import { Link } from 'react-router-dom';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useConflicts } from '../../api/queries';
import { useSession } from '../../app/session';
import { fmtDateTime, Spinner } from '../../ui/kit';

/** Server-observed exceptions only (spec §21): it cannot show unsent work held on offline devices. */
export function AttentionPanel() {
  const { camp } = useSession();
  const { data, isLoading, error } = useConflicts();
  const inCamp = (campId: string | undefined) => !campId || !camp || campId === camp.id;
  const conflicts = (data?.conflicts ?? []).filter((c) => inCamp(c.camp_id));
  const claims = (data?.custody_claims ?? []).filter((c) => c.source_type !== 'ALLOCATION_CONFLICT');
  const total = conflicts.length + claims.length;
  return (
    <aside className="attention" aria-labelledby="attention-title">
      <div className="attention-head">
        <h2 id="attention-title">Needs your attention</h2>
        {total > 0 && <span className="count-pill" aria-label={`${total} items`}>{total}</span>}
      </div>
      <p className="muted small">
        Observed exceptions only — what devices and staff have reported to the server. Work still held on
        offline devices is not visible here.
      </p>
      {isLoading && <Spinner label="Checking exceptions" />}
      {error && <p className="error-text">Could not load exceptions.</p>}
      {data && total === 0 && <p className="attention-empty">No open conflicts or custody claims.</p>}
      <ul className="attention-list">
        {conflicts.map((c) => (
          <li key={c.id} className="attention-card">
            <h3 className="attention-kind warn">
              <TriangleAlert size={20} aria-hidden /> Allocation conflict
            </h3>
            <p className="attention-item">{c.item_tag}</p>
            <p className="small">
              Local issue to <strong>{c.details?.proposed?.trekker_name ?? 'a trekker'}</strong>
              {c.details?.proposed?.batch_code ? ` (${c.details.proposed.batch_code})` : ''} was not accepted
              {c.details?.confirmed
                ? `; the server already holds an allocation${c.details.confirmed.trekker_name ? ` to ${c.details.confirmed.trekker_name}` : ''}.`
                : '.'}
            </p>
            <p className="muted small">Raised {fmtDateTime(c.created_at)} · {c.code}</p>
            <Link className="btn btn-primary btn-sm" to={`/conflicts/${c.id}`}>
              Review allocation
            </Link>
          </li>
        ))}
        {claims.map((c) => (
          <li key={c.id} className="attention-card attention-error">
            <h3 className="attention-kind err">
              <CircleAlert size={20} aria-hidden />
              {c.source_type === 'TRANSFER_MISSING' ? 'Missing handover item' : 'Unexpected item received'}
            </h3>
            <p className="attention-item">{c.item_tag}</p>
            <p className="small">{c.description}</p>
            <p className="muted small">Reported {fmtDateTime(c.created_at)}</p>
            <Link
              className="btn btn-primary btn-sm"
              to={c.source_type === 'TRANSFER_MISSING' ? `/handovers?line=${c.source_id}` : `/handovers?claim=${c.id}`}
            >
              {c.source_type === 'TRANSFER_MISSING' ? 'Resolve discrepancy' : 'Reconcile custody'}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
