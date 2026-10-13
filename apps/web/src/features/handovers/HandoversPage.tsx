import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, PackageCheck, Send, Truck } from 'lucide-react';
import { TRANSFER_LABEL, type TransferState } from '@trailops/contracts';
import { useConflicts, useOrgLocations, useTransfers } from '../../api/queries';
import type { ClaimRow, TransferLineRow, TransferRow } from '../../api/types';
import { useSession } from '../../app/session';
import { Badge, Button, EmptyState, ErrorState, fmtDateTime, Spinner } from '../../ui/kit';
import { ClaimDialog, DispatchDialog, ReceiveDialog, ResolveLineDialog } from './HandoverDialogs';

const TONE: Record<TransferState, 'info' | 'success' | 'error' | 'neutral'> = {
  DISPATCHED: 'info',
  RECEIVED: 'success',
  DISCREPANCY: 'error',
  RECONCILED: 'neutral',
};
const LINE_TONE = { PENDING: 'neutral', RECEIVED: 'success', MISSING: 'error' } as const;

type Modal =
  | { kind: 'dispatch' }
  | { kind: 'receive'; transfer: TransferRow }
  | { kind: 'line'; transfer: TransferRow; line: TransferLineRow }
  | { kind: 'claim'; claim: ClaimRow };

export function HandoversPage() {
  const { camp, can } = useSession();
  const [params, setParams] = useSearchParams();
  const transfers = useTransfers(camp?.id);
  const locations = useOrgLocations();
  const conflicts = useConflicts();
  const [filter, setFilter] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [modal, setModal] = useState<Modal | null>(null);

  const campOf = useMemo(() => new Map((locations.data ?? []).map((l) => [l.id, l.camp_id])), [locations.data]);
  const extraClaims = (conflicts.data?.custody_claims ?? []).filter((c) => c.source_type === 'TRANSFER_EXTRA');
  const rows = (transfers.data ?? []).filter((t) => {
    if (filter === 'incoming') return campOf.get(t.to.id) === camp?.id;
    if (filter === 'outgoing') return campOf.get(t.from.id) === camp?.id;
    return true;
  });

  // Deep links from "Needs your attention".
  const lineParam = params.get('line');
  const claimParam = params.get('claim');
  const deepLine = lineParam
    ? (transfers.data ?? []).flatMap((t) => t.lines.map((l) => ({ t, l }))).find((x) => x.l.id === lineParam)
    : undefined;
  const deepClaim = claimParam ? extraClaims.find((c) => c.id === claimParam) : undefined;
  const clearDeep = () => {
    const n = new URLSearchParams(params);
    n.delete('line');
    n.delete('claim');
    setParams(n, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Handovers</h1>
          <p className="page-sub">Tagged-asset transfers between locations. Quantities are derived from tags, never edited.</p>
        </div>
        {can('transfer.dispatch') && (
          <Button variant="primary" icon={<Send size={20} aria-hidden />} onClick={() => setModal({ kind: 'dispatch' })}>
            Dispatch handover
          </Button>
        )}
      </div>
      <div className="segmented" role="group" aria-label="Direction">
        {(['all', 'incoming', 'outgoing'] as const).map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'incoming' ? `Incoming to ${camp?.name.replace(/ base camp$/i, '')}` : 'Outgoing'}
          </button>
        ))}
      </div>
      {transfers.error && <ErrorState error={transfers.error} onRetry={() => void transfers.refetch()} />}
      {transfers.isLoading && <Spinner label="Loading handovers" />}
      {transfers.data && rows.length === 0 && (
        <EmptyState icon={<Truck size={32} aria-hidden />} title="No handovers">
          Dispatched manifests to or from this camp appear here.
        </EmptyState>
      )}
      <ul className="transfer-list">
        {rows.map((t) => {
          const toCamp = campOf.get(t.to.id);
          const fromCamp = campOf.get(t.from.id);
          const canReceive = t.state === 'DISPATCHED' && !!toCamp && can('transfer.receive', toCamp);
          const canResolve = (toCamp && can('transfer.resolve', toCamp)) || (fromCamp && can('transfer.resolve', fromCamp));
          const claims = extraClaims.filter((c) => c.source_id === t.id);
          const received = t.lines.filter((l) => l.receipt_state === 'RECEIVED').length;
          return (
            <li key={t.id} className="panel transfer-card">
              <header className="transfer-head">
                <div>
                  <h2 className="section-title">
                    {t.code} <Badge tone={TONE[t.state]}>{TRANSFER_LABEL[t.state]}</Badge>
                  </h2>
                  <p className="route">
                    {t.from.label} <ArrowRight size={16} aria-label="to" /> {t.to.label}
                  </p>
                  <p className="muted small">
                    Dispatched {fmtDateTime(t.dispatched_at)}
                    {t.received_at && <> · received {fmtDateTime(t.received_at)} ({received}/{t.lines.length})</>}
                  </p>
                </div>
                {canReceive && (
                  <Button variant="primary" icon={<PackageCheck size={20} aria-hidden />} onClick={() => setModal({ kind: 'receive', transfer: t })}>
                    Receive
                  </Button>
                )}
              </header>
              {t.carrier_note && <p className="small">Carrier note: {t.carrier_note}</p>}
              {t.receipt_notes && <p className="small">Receipt notes: {t.receipt_notes}</p>}
              <ul className="line-chips" aria-label={`${t.lines.length} tagged items`}>
                {t.lines.map((l) => (
                  <li key={l.id} className={`line-chip line-${l.receipt_state.toLowerCase()}`}>
                    <strong>{l.tag}</strong>
                    <Badge tone={LINE_TONE[l.receipt_state]}>
                      {l.receipt_state === 'PENDING' ? 'In transit' : l.receipt_state === 'RECEIVED' ? 'Received' : l.resolution ? `Missing → ${l.resolution.toLowerCase()}` : 'Missing'}
                    </Badge>
                    {l.receipt_state === 'MISSING' && !l.resolution && canResolve && (
                      <Button className="btn-sm" onClick={() => setModal({ kind: 'line', transfer: t, line: l })}>
                        Resolve
                      </Button>
                    )}
                    {l.discrepancy_reason && <span className="muted small line-reason">{l.discrepancy_reason}</span>}
                  </li>
                ))}
              </ul>
              {claims.length > 0 && (
                <div className="claims">
                  <h3>Extra items reported on receipt</h3>
                  <ul>
                    {claims.map((c) => (
                      <li key={c.id}>
                        <strong>{c.item_tag}</strong> <span className="small">{c.description}</span>
                        {canResolve && (
                          <Button className="btn-sm" onClick={() => setModal({ kind: 'claim', claim: c })}>
                            Reconcile
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {modal?.kind === 'dispatch' && <DispatchDialog onClose={() => setModal(null)} />}
      {modal?.kind === 'receive' && <ReceiveDialog transfer={modal.transfer} onClose={() => setModal(null)} />}
      {modal?.kind === 'line' && <ResolveLineDialog transfer={modal.transfer} line={modal.line} onClose={() => setModal(null)} />}
      {modal?.kind === 'claim' && <ClaimDialog claim={modal.claim} onClose={() => setModal(null)} />}
      {!modal && deepLine && deepLine.l.receipt_state === 'MISSING' && !deepLine.l.resolution && (
        <ResolveLineDialog transfer={deepLine.t} line={deepLine.l} onClose={clearDeep} />
      )}
      {!modal && deepClaim && <ClaimDialog claim={deepClaim} onClose={clearDeep} />}
    </div>
  );
}
