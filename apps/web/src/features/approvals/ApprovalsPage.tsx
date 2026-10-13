import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Calendar,
  Camera,
  CircleCheck,
  ClipboardList,
  FileText,
  ImageOff,
  Info,
  Play,
  User,
  Wrench,
} from 'lucide-react';
import { REPAIR_LABEL, type RepairState } from '@trailops/contracts';
import { useAttachmentUrl, useEquipmentDetail, useRepairs } from '../../api/queries';
import type { RepairRow } from '../../api/types';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  ErrorState,
  fmtDateTime,
  ReceiptNotice,
  Select,
  Spinner,
  StatusBadge,
  TextArea,
} from '../../ui/kit';
import { ReleaseDialog } from './ReleaseDialog';

const OPEN: RepairState[] = ['REQUESTED', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'IN_PROGRESS', 'AWAITING_RELEASE'];
const pretty = (s: string | null | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '—');
const EVIDENCE: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'neutral' }> = {
  NOT_REQUIRED: { label: 'No photos required', tone: 'neutral' },
  PENDING: { label: 'Photos pending upload', tone: 'warning' },
  VERIFIED: { label: 'Photos verified', tone: 'success' },
  REJECTED: { label: 'Photos rejected', tone: 'error' },
};

function stateTone(s: RepairState) {
  if (s === 'REQUESTED' || s === 'MORE_INFORMATION_REQUIRED') return 'warning' as const;
  if (s === 'CLOSED') return 'success' as const;
  if (s === 'DENIED') return 'neutral' as const;
  return 'info' as const;
}

function Photo({ att }: { att: { id: string; state: string; reason: string | null } }) {
  const verified = att.state === 'VERIFIED';
  const url = useAttachmentUrl(att.id, verified);
  if (!verified) {
    return (
      <div className="thumb thumb-empty" title={att.reason ?? undefined}>
        <ImageOff size={22} aria-hidden />
        <span className="small">{att.state === 'REJECTED' ? 'Rejected' : 'Not uploaded yet'}</span>
      </div>
    );
  }
  if (url.data) {
    return (
      <a href={url.data.url} target="_blank" rel="noreferrer" className="thumb">
        <img src={url.data.url} alt="Inspection evidence photo" />
      </a>
    );
  }
  return <div className="thumb thumb-empty">{url.error ? 'Unavailable' : '…'}</div>;
}

function DenyDialog({ repair, onClose }: { repair: RepairRow; onClose: () => void }) {
  const [disposition, setDisposition] = useState<'RETIRE' | 'QUARANTINE' | 'REPAIR' | ''>('');
  const [note, setNote] = useState('');
  const cmd = useCommand({ success: `Decision recorded for ${repair.item.tag}`, onAccepted: onClose });
  return (
    <Dialog
      title={`Deny · ${repair.item.tag}`}
      description="A denial never makes gear Ready. Choose what happens to the item instead."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            pending={cmd.pending}
            disabled={!disposition}
            onClick={() =>
              disposition &&
              void cmd.submit({
                type: 'APPROVE_REPAIR',
                aggregate_id: repair.id,
                expected_version: repair.version,
                payload: { decision: 'DENY', disposition, note: note.trim() },
              })
            }
          >
            Deny request
          </Button>
        </>
      }
    >
      <Select label="Disposition" required value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)} error={cmd.outcome?.fieldErrors?.disposition}>
        <option value="">Choose…</option>
        <option value="RETIRE">Retire the item</option>
        <option value="QUARANTINE">Keep in quarantine for review</option>
        {repair.kind === 'DISPOSITION' && <option value="REPAIR">Repair instead of retiring</option>}
      </Select>
      <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

function CompleteDialog({ repair, onClose }: { repair: RepairRow; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const cmd = useCommand({ success: `Work completed on ${repair.item.tag} — awaiting release`, onAccepted: onClose });
  return (
    <Dialog
      title={`Complete work · ${repair.item.tag}`}
      description="Record the work performed. The item stays unavailable until a release inspection passes."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            disabled={notes.trim().length < 3}
            onClick={() =>
              void cmd.submit({
                type: 'COMPLETE_REPAIR',
                aggregate_id: repair.id,
                expected_version: repair.version,
                payload: { work_notes: notes.trim() },
              })
            }
          >
            Mark work complete
          </Button>
        </>
      }
    >
      <TextArea label="Work notes" required value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} hint="At least 3 characters." error={cmd.outcome?.fieldErrors?.work_notes} />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

function Review({ repair }: { repair: RepairRow }) {
  const { can } = useSession();
  const item = useEquipmentDetail(repair.item.id);
  const campId = item.data?.location.camp_id;
  const [note, setNote] = useState('');
  const [modal, setModal] = useState<'deny' | 'complete' | 'release' | null>(null);
  const cmd = useCommand({ success: (r) => `${repair.item.tag}: ${pretty(String(r.data?.state ?? 'updated'))}` });
  const insp = repair.inspection;
  const evidence = insp?.evidence_state ?? 'NOT_REQUIRED';
  const evidenceBlocked = evidence === 'PENDING' || evidence === 'REJECTED';
  const deciding = repair.state === 'REQUESTED' || repair.state === 'MORE_INFORMATION_REQUIRED';
  const disposition = repair.kind === 'DISPOSITION';

  const decide = (decision: 'APPROVE' | 'MORE_INFORMATION') =>
    void cmd.submit({
      type: 'APPROVE_REPAIR',
      aggregate_id: repair.id,
      expected_version: repair.version,
      payload: { decision, note: note.trim() },
    });

  return (
    <article className="panel review" aria-labelledby="review-title">
      <header className="review-head">
        <div className="review-item-icon" aria-hidden>
          <Wrench size={28} />
        </div>
        <div>
          <h2 id="review-title" className="section-title">
            {item.data?.category.name ?? 'Item'} · {repair.item.tag}
          </h2>
          <p className="muted">
            {item.data?.size ? `Size ${item.data.size} · ` : ''}
            {item.data ? `${item.data.location.label}, ${item.data.location.camp_name}` : ''}
          </p>
          <div className="row-gap">
            <Badge tone={stateTone(repair.state)}>{REPAIR_LABEL[repair.state]}</Badge>
            <StatusBadge status={repair.item.status} />
            <Badge tone="neutral">{disposition ? 'Retirement decision' : 'Repair request'}</Badge>
          </div>
        </div>
      </header>

      <dl className="review-facts">
        <div>
          <dt><ClipboardList size={18} aria-hidden /> Condition</dt>
          <dd>{pretty(insp?.condition)}</dd>
        </div>
        <div>
          <dt><Wrench size={18} aria-hidden /> Issue type</dt>
          <dd>{pretty(insp?.issue_type)}</dd>
        </div>
        <div>
          <dt><FileText size={18} aria-hidden /> Inspection notes</dt>
          <dd>{insp?.notes || <span className="muted">No notes</span>}</dd>
        </div>
        <div>
          <dt><Calendar size={18} aria-hidden /> Reported on</dt>
          <dd>{fmtDateTime(insp?.submitted_at ?? repair.created_at)}</dd>
        </div>
        {repair.issued_to && (
          <div>
            <dt><User size={18} aria-hidden /> Trekker</dt>
            <dd>{repair.issued_to.trekker_name} · Batch {repair.issued_to.batch_code}</dd>
          </div>
        )}
        <div>
          <dt><User size={18} aria-hidden /> Submitted by</dt>
          <dd>{insp?.submitted_by ?? repair.requested_by ?? '—'}</dd>
        </div>
        <div>
          <dt><Camera size={18} aria-hidden /> Photos</dt>
          <dd>
            <Badge tone={EVIDENCE[evidence]?.tone ?? 'neutral'}>{EVIDENCE[evidence]?.label ?? evidence}</Badge>
            {insp && insp.attachments.length > 0 && (
              <div className="thumbs">
                {insp.attachments.map((a) => (
                  <Photo key={a.id} att={a} />
                ))}
              </div>
            )}
          </dd>
        </div>
        {repair.decision_note && (
          <div>
            <dt><Info size={18} aria-hidden /> Decision note</dt>
            <dd>{repair.decision_note}</dd>
          </div>
        )}
        {repair.work_notes && (
          <div>
            <dt><Wrench size={18} aria-hidden /> Work notes</dt>
            <dd>{repair.work_notes}</dd>
          </div>
        )}
      </dl>

      {repair.state !== 'CLOSED' && repair.state !== 'DENIED' && (
        <Callout tone="warning">Item stays unavailable until the repair is completed and released.</Callout>
      )}

      {deciding && can('repair.approve', campId) && (
        <div className="review-actions">
          {evidenceBlocked && (
            <Callout tone="error" title="Approval blocked: evidence not verified">
              {evidence === 'PENDING'
                ? 'The inspection was received, but its photos have not uploaded and verified yet. Approval unlocks once they do — the field device uploads them when it reconnects.'
                : 'The submitted photos were rejected by verification. Request more information so the operator can provide new evidence.'}
            </Callout>
          )}
          {repair.state === 'MORE_INFORMATION_REQUIRED' && (
            <Callout tone="info">More information was requested. You can decide again once it has arrived.</Callout>
          )}
          <TextArea
            label="Decision note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            hint="Required when requesting more information."
            error={cmd.outcome?.fieldErrors?.note}
          />
          <div className="btn-row">
            <Button
              variant="primary"
              className="btn-lg"
              icon={<CircleCheck size={20} aria-hidden />}
              pending={cmd.pending}
              disabled={evidenceBlocked}
              aria-describedby={evidenceBlocked ? 'approve-blocked' : undefined}
              onClick={() => decide('APPROVE')}
            >
              {disposition ? 'Approve retirement' : 'Approve repair'}
            </Button>
            <Button className="btn-lg" pending={cmd.pending} disabled={!note.trim()} onClick={() => decide('MORE_INFORMATION')}>
              Request more information
            </Button>
            <Button variant="ghost" className="btn-lg" disabled={cmd.pending} onClick={() => setModal('deny')}>
              Deny…
            </Button>
          </div>
          {evidenceBlocked && (
            <p id="approve-blocked" className="sr-only">
              Approval is disabled until photo evidence is verified.
            </p>
          )}
        </div>
      )}

      {repair.state === 'APPROVED' && can('repair.work', campId) && (
        <div className="btn-row">
          <Button
            variant="primary"
            className="btn-lg"
            icon={<Play size={20} aria-hidden />}
            pending={cmd.pending}
            onClick={() =>
              void cmd.submit({ type: 'START_REPAIR', aggregate_id: repair.id, expected_version: repair.version, payload: {} })
            }
          >
            Start work
          </Button>
        </div>
      )}
      {repair.state === 'IN_PROGRESS' && can('repair.work', campId) && (
        <div className="btn-row">
          <Button variant="primary" className="btn-lg" onClick={() => setModal('complete')}>
            Complete work…
          </Button>
        </div>
      )}
      {repair.state === 'AWAITING_RELEASE' && can('repair.release', campId) && (
        <div className="btn-row">
          <Button variant="primary" className="btn-lg" onClick={() => setModal('release')}>
            Release inspection…
          </Button>
        </div>
      )}
      <ReceiptNotice outcome={cmd.outcome} />
      {modal === 'deny' && <DenyDialog repair={repair} onClose={() => setModal(null)} />}
      {modal === 'complete' && <CompleteDialog repair={repair} onClose={() => setModal(null)} />}
      {modal === 'release' && (
        <ReleaseDialog
          item={{ id: repair.item.id, tag: repair.item.tag, version: repair.item.version }}
          context="Work is complete. A passed release inspection closes the repair and makes the item Ready; a failure sends it back to the bench."
          onClose={() => setModal(null)}
        />
      )}
    </article>
  );
}

export function ApprovalsPage() {
  const { camp } = useSession();
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const repairs = useRepairs(camp?.id);
  const list = useMemo(
    () => (repairs.data ?? []).filter((r) => scope === 'all' || OPEN.includes(r.state)),
    [repairs.data, scope],
  );
  const selectedId = params.get('repair') ?? list[0]?.id ?? null;
  const selected = (repairs.data ?? []).find((r) => r.id === selectedId) ?? null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Repair approvals</h1>
          <p className="page-sub">Review returned gear, decide, track work and release through inspection.</p>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          <button aria-pressed={scope === 'open'} onClick={() => setScope('open')}>Open</button>
          <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
        </div>
      </div>
      {repairs.error && <ErrorState error={repairs.error} onRetry={() => void repairs.refetch()} />}
      {repairs.isLoading && <Spinner label="Loading repair queue" />}
      {repairs.data && list.length === 0 && (
        <EmptyState icon={<Wrench size={32} aria-hidden />} title={scope === 'open' ? 'No open repair requests' : 'No repair requests'}>
          Requests appear here when a return inspection marks gear as needing repair or unusable.
        </EmptyState>
      )}
      {list.length > 0 && (
        <div className="split">
          <ul className="queue" aria-label="Repair queue">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  className={`queue-card ${r.id === selected?.id ? 'active' : ''}`}
                  aria-current={r.id === selected?.id || undefined}
                  onClick={() => setParams({ repair: r.id }, { replace: true })}
                >
                  <span className="queue-top">
                    <strong>{r.item.tag}</strong>
                    <Badge tone={stateTone(r.state)}>{REPAIR_LABEL[r.state]}</Badge>
                  </span>
                  <span className="small">
                    {pretty(r.inspection?.condition)} · {pretty(r.inspection?.issue_type)}
                  </span>
                  <span className="muted small">
                    {r.inspection?.submitted_by ?? r.requested_by} · {fmtDateTime(r.created_at)}
                  </span>
                  {r.inspection?.evidence_state === 'PENDING' && <span className="small warn-text">Photos pending</span>}
                </button>
              </li>
            ))}
          </ul>
          {selected ? <Review key={selected.id + selected.version} repair={selected} /> : <p className="muted">Select a request.</p>}
        </div>
      )}
    </div>
  );
}
