import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, ClipboardCheck, QrCode } from 'lucide-react';
import { REPAIR_LABEL } from '@trailops/contracts';
import { useEquipmentDetail, useEquipmentHistory } from '../../api/queries';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorState,
  fmtDate,
  fmtDateTime,
  ReceiptNotice,
  shortId,
  Spinner,
  StatusBadge,
  TextArea,
} from '../../ui/kit';
import { QrLabelDialog } from './QrLabelDialog';
import { ReleaseDialog } from '../approvals/ReleaseDialog';
import { AuditDiff } from '../audit/AuditDiff';

const OPEN_REPAIR = ['REQUESTED', 'MORE_INFORMATION_REQUIRED', 'APPROVED', 'IN_PROGRESS', 'AWAITING_RELEASE'];
const EVIDENCE_LABEL: Record<string, string> = {
  NOT_REQUIRED: 'No photos required',
  PENDING: 'Photos pending upload',
  VERIFIED: 'Photos verified',
  REJECTED: 'Photos rejected',
};

function RetireDialog({ item, onClose }: { item: { id: string; tag: string; version: number }; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const cmd = useCommand({ success: `${item.tag} retired`, onAccepted: onClose });
  const tooShort = reason.trim().length < 3;
  return (
    <Dialog
      title={`Retire ${item.tag}`}
      description="Retired items leave circulation permanently but remain in history. Any open repair request is closed."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            pending={cmd.pending}
            disabled={tooShort}
            onClick={() =>
              void cmd.submit({
                type: 'RETIRE_EQUIPMENT',
                aggregate_id: item.id,
                expected_version: item.version,
                payload: { reason: reason.trim() },
              })
            }
          >
            Retire item
          </Button>
        </>
      }
    >
      <TextArea
        label="Reason"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        hint="Recorded in the audit trail. At least 3 characters."
        error={cmd.outcome?.fieldErrors?.reason}
      />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

export function EquipmentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const detail = useEquipmentDetail(id);
  const history = useEquipmentHistory(id);
  const [modal, setModal] = useState<'qr' | 'retire' | 'release' | null>(null);
  const d = detail.data;
  const campId = d?.location.camp_id;
  const openRepair = d?.repair && OPEN_REPAIR.includes(d.repair.state) ? d.repair : null;
  const canRelease = d && d.status === 'QUARANTINED' && !openRepair && can('repair.release', campId);
  const canRetire = d && !['ISSUED', 'IN_TRANSIT', 'RETIRED'].includes(d.status) && can('equipment.retire', campId);
  const events = history.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Dialog
      variant="drawer"
      title={d ? `${d.tag} · ${d.category.name}` : 'Equipment'}
      description={d ? `${d.location.label}, ${d.location.camp_name}` : undefined}
      onClose={onClose}
    >
      {detail.error && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
      {!d && !detail.error && <Spinner label="Loading item" />}
      {d && (
        <div className="drawer-content">
          <div className="drawer-status">
            <StatusBadge status={d.status} />
            <span className="muted small">
              Version {d.version} · updated {fmtDateTime(d.updated_at)}
            </span>
          </div>
          <div className="drawer-actions">
            <Button icon={<QrCode size={18} aria-hidden />} onClick={() => setModal('qr')}>
              QR label
            </Button>
            {canRelease && (
              <Button variant="primary" icon={<ClipboardCheck size={18} aria-hidden />} onClick={() => setModal('release')}>
                Release inspection
              </Button>
            )}
            {canRetire && (
              <Button variant="danger" icon={<Ban size={18} aria-hidden />} onClick={() => setModal('retire')}>
                Retire
              </Button>
            )}
          </div>
          {d.status === 'QUARANTINED' && !openRepair && (
            <Callout tone="warning">Needs a release inspection before it can be issued again.</Callout>
          )}

          <dl className="facts">
            <dt>Tag</dt>
            <dd><strong>{d.tag}</strong></dd>
            <dt>Category</dt>
            <dd>{d.category.name} <span className="muted">({d.category.group})</span></dd>
            <dt>Size</dt>
            <dd>{d.size ?? '—'}</dd>
            <dt>Location</dt>
            <dd>{d.location.label}, {d.location.camp_name}</dd>
            {d.notes && (
              <>
                <dt>Notes</dt>
                <dd>{d.notes}</dd>
              </>
            )}
          </dl>

          <section className="drawer-section">
            <h3>Current allocation</h3>
            {d.allocation ? (
              <dl className="facts">
                <dt>Trekker</dt>
                <dd>{d.allocation.trekker_name}</dd>
                <dt>Batch</dt>
                <dd>{d.allocation.batch_code} · {d.allocation.trek_name}</dd>
                <dt>Due back</dt>
                <dd>{fmtDate(d.allocation.due_date)}</dd>
              </dl>
            ) : (
              <p className="muted">No active allocation.</p>
            )}
          </section>

          {d.repair && (
            <section className="drawer-section">
              <h3>Repair</h3>
              <p>
                <Badge tone={openRepair ? 'warning' : 'neutral'}>{REPAIR_LABEL[d.repair.state]}</Badge>{' '}
                <span className="muted small">{d.repair.kind === 'DISPOSITION' ? 'Disposition decision' : 'Repair request'}</span>
              </p>
              {d.repair.decision_note && <p className="small">Decision note: {d.repair.decision_note}</p>}
              {d.repair.work_notes && <p className="small">Work notes: {d.repair.work_notes}</p>}
              {openRepair && can('repair.approve', campId) && (
                <Link to={`/approvals?repair=${d.repair.id}`} className="link">Open in repair queue</Link>
              )}
            </section>
          )}

          <section className="drawer-section">
            <h3>Last inspection</h3>
            {d.last_inspection ? (
              <dl className="facts">
                <dt>Type</dt>
                <dd>{d.last_inspection.kind.toLowerCase()}</dd>
                <dt>Condition</dt>
                <dd>{d.last_inspection.condition.replace('_', ' ').toLowerCase()}</dd>
                {d.last_inspection.issue_type && (
                  <>
                    <dt>Issue</dt>
                    <dd>{d.last_inspection.issue_type.replace(/_/g, ' ').toLowerCase()}</dd>
                  </>
                )}
                <dt>Evidence</dt>
                <dd>{EVIDENCE_LABEL[d.last_inspection.evidence_state] ?? d.last_inspection.evidence_state}</dd>
                <dt>Recorded</dt>
                <dd>{fmtDateTime(d.last_inspection.submitted_at)}</dd>
                {d.last_inspection.notes && (
                  <>
                    <dt>Notes</dt>
                    <dd>{d.last_inspection.notes}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="muted">No inspections recorded.</p>
            )}
          </section>

          <section className="drawer-section">
            <h3>Custody claims</h3>
            {d.custody_claims.length === 0 ? (
              <p className="muted">No open custody claims.</p>
            ) : (
              <ul className="plain-list">
                {d.custody_claims.map((c) => (
                  <li key={c.id}>
                    <Badge tone="error">{c.source_type.replace(/_/g, ' ').toLowerCase()}</Badge>
                    <p className="small">{c.description}</p>
                    <p className="muted small">Raised {fmtDateTime(c.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="drawer-section">
            <h3>Audit history</h3>
            {history.isLoading && <Spinner label="Loading history" />}
            {events.length === 0 && !history.isLoading && <p className="muted">No recorded events.</p>}
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <div className="timeline-head">
                    <strong>{e.summary ?? e.event_type.replace(/_/g, ' ').toLowerCase()}</strong>
                    <span className="muted small">{fmtDateTime(e.recorded_at)}</span>
                  </div>
                  <div className="muted small">
                    {e.actor_name ?? 'System'} · {e.command_type ?? e.event_type} · {e.aggregate_type}
                    {e.operation_id && <> · op {shortId(e.operation_id)}</>}
                  </div>
                  <AuditDiff before={e.before} after={e.after} compact />
                </li>
              ))}
            </ol>
            {history.hasNextPage && (
              <Button onClick={() => void history.fetchNextPage()} pending={history.isFetchingNextPage}>
                Older events
              </Button>
            )}
          </section>
        </div>
      )}
      {d && modal === 'qr' && (
        <QrLabelDialog itemId={d.id} tag={d.tag} subtitle={`${d.category.name}${d.size ? ` · ${d.size}` : ''}`} onClose={() => setModal(null)} />
      )}
      {d && modal === 'retire' && <RetireDialog item={d} onClose={() => setModal(null)} />}
      {d && modal === 'release' && (
        <ReleaseDialog
          item={d}
          context="This item is quarantined (e.g. received from a handover or returned in good condition). A passed release check makes it Ready."
          onClose={() => setModal(null)}
        />
      )}
    </Dialog>
  );
}
