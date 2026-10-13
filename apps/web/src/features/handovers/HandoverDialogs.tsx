import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useCamps, useEquipmentPicker, useOrgLocations } from '../../api/queries';
import type { ClaimRow, TransferLineRow, TransferRow } from '../../api/types';
import { useCommand } from '../../api/useCommand';
import { useSession } from '../../app/session';
import { Button, Callout, Dialog, ReceiptNotice, Select, Spinner, StatusBadge, TextArea, TextInput } from '../../ui/kit';

export function DispatchDialog({ onClose }: { onClose: () => void }) {
  const { camp } = useSession();
  const camps = useCamps();
  const orgLocations = useOrgLocations();
  // Transfer id minted once per dialog, so retries cannot create a second manifest.
  const [transferId] = useState(() => crypto.randomUUID());
  const origins = camps.data?.find((c) => c.id === camp?.id)?.locations ?? [];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const items = useEquipmentPicker({ location_id: from || undefined, status: 'READY' }, !!from);
  const cmd = useCommand({ success: (r) => `Dispatched ${String(r.data?.code ?? '')} with ${String(r.data?.lines ?? picked.size)} items`, onAccepted: onClose });

  const available = useMemo(
    () =>
      (items.data?.items ?? []).filter(
        (i) => !filter || i.tag.toLowerCase().includes(filter.toLowerCase()) || i.category.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [items.data, filter],
  );
  const byCamp = useMemo(() => {
    const groups = new Map<string, { camp: string; locs: { id: string; label: string }[] }>();
    for (const l of orgLocations.data ?? []) {
      if (l.id === from) continue;
      const g = groups.get(l.camp_id) ?? { camp: l.camp_name, locs: [] };
      g.locs.push(l);
      groups.set(l.camp_id, g);
    }
    return [...groups.values()];
  }, [orgLocations.data, from]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectedItems = (items.data?.items ?? []).filter((i) => picked.has(i.id));
  const valid = from && to && from !== to && selectedItems.length > 0;

  return (
    <Dialog
      wide
      title="Dispatch handover"
      description="Choose the tagged items leaving this location. The manifest is immutable once dispatched; all items must be Ready at the origin or nothing is dispatched."
      onClose={onClose}
      footer={
        <>
          <span className="muted small grow">{selectedItems.length} item{selectedItems.length === 1 ? '' : 's'} selected</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            disabled={!valid}
            onClick={() =>
              void cmd.submit({
                type: 'DISPATCH_TRANSFER',
                aggregate_id: transferId,
                preconditions: selectedItems
                  .map((i) => ({ entity: 'equipment' as const, id: i.id, expected_version: i.version }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
                payload: {
                  from_location_id: from,
                  to_location_id: to,
                  item_ids: selectedItems.map((i) => i.id).sort(),
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
              })
            }
          >
            Dispatch {selectedItems.length || ''} item{selectedItems.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="form-grid two">
        <Select
          label="Origin"
          required
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPicked(new Set());
          }}
        >
          <option value="">Choose a location in {camp?.name}</option>
          {origins.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </Select>
        <Select label="Destination" required value={to} onChange={(e) => setTo(e.target.value)} error={from && to === from ? 'Destination must differ from origin' : null}>
          <option value="">Choose destination</option>
          {byCamp.map((g) => (
            <optgroup key={g.camp} label={g.camp}>
              {g.locs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {from && (
        <fieldset className="pick-list">
          <legend>Ready items at origin</legend>
          <TextInput label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Tag or item name" />
          {items.isLoading && <Spinner label="Loading ready items" />}
          {items.data && available.length === 0 && <p className="muted">No Ready items here.</p>}
          <ul>
            {available.map((i) => (
              <li key={i.id}>
                <label className={`pick ${picked.has(i.id) ? 'checked' : ''}`}>
                  <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                  <strong>{i.tag}</strong>
                  <span>{i.category.name}</span>
                  <span className="muted">{i.size ?? ''}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <TextArea label="Carrier note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Sent with porter team, jeep UK07…" />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

interface ReceiptLineState {
  result: 'RECEIVED' | 'MISSING';
  note: string;
}

export function ReceiveDialog({ transfer, onClose }: { transfer: TransferRow; onClose: () => void }) {
  const [lines, setLines] = useState<Record<string, ReceiptLineState>>(() =>
    Object.fromEntries(transfer.lines.map((l) => [l.item_id, { result: 'RECEIVED', note: '' }])),
  );
  const [extras, setExtras] = useState<{ tag: string; note: string }[]>([]);
  const [notes, setNotes] = useState('');
  const cmd = useCommand({ success: (r) => `${transfer.code} received${r.data?.missing ? ` · ${String(r.data.missing)} missing` : ''}`, onAccepted: onClose });
  const missing = Object.values(lines).filter((l) => l.result === 'MISSING').length;
  const set = (id: string, patch: Partial<ReceiptLineState>) => setLines((ls) => ({ ...ls, [id]: { ...ls[id]!, ...patch } }));
  const cleanExtras = extras.filter((e) => e.tag.trim());
  return (
    <Dialog
      wide
      title={`Receive ${transfer.code}`}
      description={`${transfer.from.label} → ${transfer.to.label}. Confirm every dispatched tag. Received items move here and stay quarantined until a release inspection; missing items stay blocked as Missing.`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small grow">
            {transfer.lines.length - missing} received · {missing} missing{cleanExtras.length ? ` · ${cleanExtras.length} extra` : ''}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            onClick={() =>
              void cmd.submit({
                type: 'RECEIVE_TRANSFER',
                aggregate_id: transfer.id,
                expected_version: transfer.version,
                payload: {
                  lines: transfer.lines.map((l) => ({
                    item_id: l.item_id,
                    result: lines[l.item_id]!.result,
                    ...(lines[l.item_id]!.note.trim() ? { note: lines[l.item_id]!.note.trim() } : {}),
                  })),
                  ...(cleanExtras.length
                    ? { extra_items: cleanExtras.map((e) => ({ tag: e.tag.trim().toUpperCase(), ...(e.note.trim() ? { note: e.note.trim() } : {}) })) }
                    : {}),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                },
              })
            }
          >
            Confirm receipt
          </Button>
        </>
      }
    >
      <table className="table receive-table">
        <caption className="sr-only">Per-tag receipt</caption>
        <thead>
          <tr>
            <th scope="col">Tag</th>
            <th scope="col">Result</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {transfer.lines.map((l) => {
            const st = lines[l.item_id]!;
            return (
              <tr key={l.id} className={st.result === 'MISSING' ? 'row-missing' : ''}>
                <th scope="row">{l.tag}</th>
                <td>
                  <div className="segmented" role="radiogroup" aria-label={`Result for ${l.tag}`}>
                    <button role="radio" aria-checked={st.result === 'RECEIVED'} onClick={() => set(l.item_id, { result: 'RECEIVED' })}>
                      Received
                    </button>
                    <button role="radio" aria-checked={st.result === 'MISSING'} onClick={() => set(l.item_id, { result: 'MISSING' })}>
                      Missing
                    </button>
                  </div>
                </td>
                <td>
                  <input
                    className="input"
                    aria-label={`Note for ${l.tag}`}
                    value={st.note}
                    maxLength={300}
                    placeholder={st.result === 'MISSING' ? 'What was observed?' : ''}
                    onChange={(e) => set(l.item_id, { note: e.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <fieldset className="extras">
        <legend>Extra items not on the manifest</legend>
        <p className="muted small">Each known tag creates a custody claim for supervisor reconciliation. Unknown tags are noted on the receipt.</p>
        {extras.map((e, i) => (
          <div className="extra-row" key={i}>
            <input className="input" aria-label={`Extra tag ${i + 1}`} placeholder="Tag, e.g. BPK-012" value={e.tag} maxLength={40} onChange={(ev) => setExtras((xs) => xs.map((x, j) => (j === i ? { ...x, tag: ev.target.value.toUpperCase() } : x)))} />
            <input className="input" aria-label={`Note for extra tag ${i + 1}`} placeholder="Note" value={e.note} maxLength={300} onChange={(ev) => setExtras((xs) => xs.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} />
            <button className="icon-btn" aria-label={`Remove extra tag ${i + 1}`} onClick={() => setExtras((xs) => xs.filter((_, j) => j !== i))}>
              <Trash2 size={18} />
            </button>
          </div>
        ))}
        <Button icon={<Plus size={18} aria-hidden />} onClick={() => setExtras((xs) => [...xs, { tag: '', note: '' }])}>
          Add extra tag
        </Button>
      </fieldset>
      <TextArea label="Receipt notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      {missing > 0 && <Callout tone="warning">{missing} item{missing === 1 ? '' : 's'} will be marked Missing and need a supervisor's discrepancy resolution.</Callout>}
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

export function ResolveLineDialog({ transfer, line, onClose }: { transfer: TransferRow; line: TransferLineRow; onClose: () => void }) {
  const camps = useCamps();
  const [finding, setFinding] = useState<'FOUND' | 'LOST' | ''>('');
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const cmd = useCommand({ success: (r) => `${line.tag}: ${r.data?.item_status === 'RETIRED' ? 'recorded as lost' : 'found — quarantined for inspection'}`, onAccepted: onClose });
  const valid = finding && reason.trim().length >= 3 && (finding === 'LOST' || locationId);
  return (
    <Dialog
      title={`Resolve missing ${line.tag}`}
      description={`Dispatched on ${transfer.code} (${transfer.from.label} → ${transfer.to.label}) but not received. Record what a physical check found — this never fabricates a receipt.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            disabled={!valid}
            onClick={() =>
              finding &&
              void cmd.submit({
                type: 'RESOLVE_TRANSFER_DISCREPANCY',
                aggregate_id: line.id,
                payload: { finding, reason: reason.trim(), ...(finding === 'FOUND' ? { location_id: locationId } : {}) },
              })
            }
          >
            Record finding
          </Button>
        </>
      }
    >
      {line.discrepancy_reason && <p className="small">Receiver noted: <em>{line.discrepancy_reason}</em></p>}
      <fieldset className="radio-group">
        <legend>Finding</legend>
        <label className={`radio-card ${finding === 'FOUND' ? 'checked' : ''}`}>
          <input type="radio" name="finding" checked={finding === 'FOUND'} onChange={() => setFinding('FOUND')} />
          <span>
            <strong>Found</strong>
            <span className="muted small block">Physically located. It moves there and is quarantined until released.</span>
          </span>
        </label>
        <label className={`radio-card ${finding === 'LOST' ? 'checked' : ''}`}>
          <input type="radio" name="finding" checked={finding === 'LOST'} onChange={() => setFinding('LOST')} />
          <span>
            <strong>Lost</strong>
            <span className="muted small block">Not recoverable. The item is retired from circulation.</span>
          </span>
        </label>
      </fieldset>
      {finding === 'FOUND' && (
        <Select label="Where was it found?" required value={locationId} onChange={(e) => setLocationId(e.target.value)} error={cmd.outcome?.fieldErrors?.location_id}>
          <option value="">Choose location</option>
          {camps.data?.map((c) => (
            <optgroup key={c.id} label={c.name}>
              {c.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      )}
      <TextArea label="Reason / evidence" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} hint="Who checked, where, and what was seen. At least 3 characters." error={cmd.outcome?.fieldErrors?.reason} />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}

export function ClaimDialog({ claim, onClose }: { claim: ClaimRow; onClose: () => void }) {
  const camps = useCamps();
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const item = useEquipmentPicker({ q: claim.item_tag }, true);
  const row = item.data?.items.find((i) => i.id === claim.item_id);
  const cmd = useCommand({ success: `Custody claim for ${claim.item_tag} resolved`, onAccepted: onClose });
  return (
    <Dialog
      title={`Reconcile custody · ${claim.item_tag}`}
      description={claim.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            disabled={note.trim().length < 3}
            onClick={() =>
              void cmd.submit({
                type: 'RESOLVE_CUSTODY_CLAIM',
                aggregate_id: claim.id,
                payload: { note: note.trim(), ...(locationId ? { location_id: locationId } : {}) },
              })
            }
          >
            Resolve claim
          </Button>
        </>
      }
    >
      {row && (
        <p>
          Server record: <StatusBadge status={row.status} /> at {row.location.label}, {row.location.camp_name}
        </p>
      )}
      <Select label="Relocate to (optional)" value={locationId} onChange={(e) => setLocationId(e.target.value)} hint="Choose where the item physically is. Ready or missing items become quarantined there until released.">
        <option value="">Keep current server location</option>
        {camps.data?.map((c) => (
          <optgroup key={c.id} label={c.name}>
            {c.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <TextArea label="Reconciliation note" required value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} hint="Physical check performed. At least 3 characters." />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}
