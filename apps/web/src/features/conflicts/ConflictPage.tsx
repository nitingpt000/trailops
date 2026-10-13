import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react';
import { useEquipmentPicker, useResolvedConflicts } from '../../api/queries';
import type { ConflictRow } from '../../api/types';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import { Badge, Button, Callout, EmptyState, ErrorState, fmtDate, fmtDateTime, ReceiptNotice, Select, Spinner, TextArea, TextInput, shortId } from '../../ui/kit';

type Resolution = 'CANCEL_LOCAL_CLAIM' | 'REPLACE' | 'REASSIGN';

function Resolve({ conflict }: { conflict: ConflictRow }) {
  const { can } = useSession();
  const proposed = conflict.details.proposed;
  const canLocal = can('conflict.resolve_local', conflict.camp_id) || can('conflict.resolve', conflict.camp_id);
  const canSupervise = can('conflict.resolve', conflict.camp_id);
  const [resolution, setResolution] = useState<Resolution | ''>('');
  const [note, setNote] = useState('');
  const [itemId, setItemId] = useState('');
  const [due, setDue] = useState(proposed?.due_date ?? '');
  // Client-generated ids, fixed for this view so a retry reuses them.
  const [replacementAllocationId] = useState(() => crypto.randomUUID());
  const [reassignAllocationId] = useState(() => crypto.randomUUID());
  const ready = useEquipmentPicker({ camp_id: conflict.camp_id, status: 'READY' }, resolution === 'REPLACE');
  const replacement = ready.data?.items.find((i) => i.id === itemId);
  const cmd = useCommand({ success: 'Conflict resolved' });

  const valid =
    resolution &&
    note.trim().length >= 3 &&
    (resolution !== 'REPLACE' || (replacement && /^\d{4}-\d{2}-\d{2}$/.test(due)));

  const submit = () => {
    if (!resolution) return;
    void cmd.submit({
      type: 'RESOLVE_ALLOCATION_CONFLICT',
      aggregate_id: conflict.id,
      expected_version: conflict.version,
      payload: {
        resolution,
        note: note.trim(),
        ...(resolution === 'REPLACE' && replacement
          ? { replacement: { item_id: replacement.id, allocation_id: replacementAllocationId, due_date: due, expected_version: replacement.version } }
          : {}),
        ...(resolution === 'REASSIGN' ? { reassign_allocation_id: reassignAllocationId } : {}),
      },
    });
  };

  if (!canLocal) {
    return <Callout tone="info">You can view this conflict but not resolve it.</Callout>;
  }
  const option = (value: Resolution, title: string, body: string, disabled = false) => (
    <label className={`radio-card ${resolution === value ? 'checked' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="radio" name="resolution" value={value} disabled={disabled} checked={resolution === value} onChange={() => setResolution(value)} />
      <span>
        <strong>{title}</strong>
        <span className="muted small block">{body}</span>
      </span>
    </label>
  );
  return (
    <section className="panel" aria-labelledby="resolve-title">
      <h2 id="resolve-title" className="section-title">Resolve</h2>
      <fieldset className="radio-group">
        <legend>Resolution</legend>
        {option('CANCEL_LOCAL_CLAIM', 'Item retrieved — cancel the local claim', 'The operator confirmed they took the item back. The confirmed allocation stays as it is.')}
        {option('REPLACE', 'Issue replacement gear', `Give ${proposed?.trekker_name ?? 'the trekker'} a different Ready item; the conflict closes only if the replacement issue succeeds.`)}
        {option(
          'REASSIGN',
          'Reassign the confirmed allocation (supervisor)',
          canSupervise
            ? 'After checking physical custody, reverse the server allocation and allocate this item to the local recipient. Fully audited.'
            : 'Requires the supervisor permission conflict.resolve.',
          !canSupervise,
        )}
      </fieldset>
      {resolution === 'REPLACE' && (
        <div className="form-grid two">
          <Select label="Replacement item" required value={itemId} onChange={(e) => setItemId(e.target.value)} hint="Ready items at this camp." error={cmd.outcome?.fieldErrors?.replacement}>
            <option value="">{ready.isLoading ? 'Loading…' : 'Choose a Ready item'}</option>
            {ready.data?.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.tag} · {i.category.name}
                {i.size ? ` · ${i.size}` : ''}
              </option>
            ))}
          </Select>
          <TextInput label="Due date" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      )}
      {resolution === 'REASSIGN' && (
        <Callout tone="warning" title="This reverses a confirmed allocation">
          Only do this after physically confirming who holds {conflict.item_tag}. The reversal and new allocation are both recorded in the audit trail.
        </Callout>
      )}
      <TextArea label="Note" required value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} hint="What was physically checked. At least 3 characters." error={cmd.outcome?.fieldErrors?.note} />
      <div className="btn-row">
        <Button variant="primary" className="btn-lg" pending={cmd.pending} disabled={!valid} onClick={submit}>
          Resolve conflict
        </Button>
      </div>
      <ReceiptNotice outcome={cmd.outcome} />
    </section>
  );
}

export function ConflictPage() {
  const { id } = useParams();
  const q = useResolvedConflicts();
  const conflict = q.data?.conflicts.find((c) => c.id === id);
  const p = conflict?.details.proposed;
  const c = conflict?.details.confirmed;
  return (
    <div className="page">
      <Link to="/equipment" className="back-link">
        <ArrowLeft size={18} aria-hidden /> Equipment
      </Link>
      {q.isLoading && <Spinner label="Loading conflict" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && !conflict && <EmptyState title="Conflict not found">It may be outside your camps.</EmptyState>}
      {conflict && (
        <>
          <div className="page-head">
            <div>
              <h1 className="page-title">Allocation conflict · {conflict.item_tag}</h1>
              <p className="page-sub">
                The first accepted server allocation wins the database decision — not necessarily physical custody. Reconcile what actually happened.
              </p>
            </div>
            <Badge tone={conflict.state === 'OPEN' ? 'warning' : 'success'}>
              {conflict.state === 'OPEN' ? 'Open' : `Resolved · ${conflict.resolution?.replace(/_/g, ' ').toLowerCase()}`}
            </Badge>
          </div>
          <Callout tone="warning" title={conflict.code}>
            {conflict.details.message}
          </Callout>
          <div className="compare">
            <section className="panel compare-col" aria-labelledby="proposed-h">
              <h2 id="proposed-h" className="section-title">
                <Smartphone size={20} aria-hidden /> Local claim (not accepted)
              </h2>
              <dl className="facts">
                <dt>Trekker</dt>
                <dd>{p?.trekker_name ?? <span className="muted">Not visible</span>}</dd>
                <dt>Batch</dt>
                <dd>{p?.batch_code ?? '—'}</dd>
                <dt>Due date</dt>
                <dd>{fmtDate(p?.due_date)}</dd>
                <dt>Issued by</dt>
                <dd>{p?.issued_by_name ?? '—'}</dd>
                <dt>Observed on device</dt>
                <dd>{fmtDateTime(p?.observed_at)}</dd>
                <dt>Reached server</dt>
                <dd>{fmtDateTime(conflict.created_at)}</dd>
                <dt>Operation</dt>
                <dd><code>{shortId(conflict.operation_id)}</code></dd>
              </dl>
            </section>
            <section className="panel compare-col" aria-labelledby="confirmed-h">
              <h2 id="confirmed-h" className="section-title">
                <ShieldCheck size={20} aria-hidden /> Confirmed on server
              </h2>
              {c ? (
                <dl className="facts">
                  <dt>Trekker</dt>
                  <dd>{c.trekker_name ?? <span className="muted">Outside your scope</span>}</dd>
                  <dt>Batch</dt>
                  <dd>{c.batch_code ?? <span className="muted">Outside your scope</span>}</dd>
                  <dt>Issued at</dt>
                  <dd>{fmtDateTime(c.issued_at)}</dd>
                  <dt>Allocation</dt>
                  <dd><code>{shortId(c.allocation_id)}</code></dd>
                </dl>
              ) : (
                <p className="muted">
                  <TriangleAlert size={16} aria-hidden /> No confirmed allocation was recorded — the item was {conflict.details.item_status?.replace(/_/g, ' ').toLowerCase()} when the claim arrived.
                </p>
              )}
            </section>
          </div>
          {conflict.state === 'OPEN' ? <Resolve conflict={conflict} /> : <Callout tone="success">This conflict is resolved. See the audit trail for details.</Callout>}
        </>
      )}
    </div>
  );
}
