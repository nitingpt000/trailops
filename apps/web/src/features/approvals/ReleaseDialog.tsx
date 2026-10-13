import { useState } from 'react';
import { useCommand } from '../../api/useCommand';
import { Button, Dialog, ReceiptNotice, TextArea } from '../../ui/kit';

/**
 * Release inspection → RELEASE_EQUIPMENT. PASS returns the item to READY; FAIL keeps it blocked
 * (back to the bench for an open repair, otherwise quarantined).
 */
export function ReleaseDialog({
  item,
  context,
  onClose,
}: {
  item: { id: string; tag: string; version: number };
  context?: string;
  onClose: () => void;
}) {
  // One inspection id per dialog: a retry of the same submission reuses it (and the operation id).
  const [inspectionId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<'PASS' | 'FAIL'>('PASS');
  const [notes, setNotes] = useState('');
  const cmd = useCommand({ success: (r) => `${item.tag} ${r.data?.status === 'READY' ? 'released — now Ready' : 'stays blocked'}`, onAccepted: onClose });
  return (
    <Dialog
      title={`Release inspection · ${item.tag}`}
      description={context ?? 'Record the physical release check. Only a pass makes the item issuable again.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={cmd.pending}
            onClick={() =>
              void cmd.submit({
                type: 'RELEASE_EQUIPMENT',
                aggregate_id: item.id,
                expected_version: item.version,
                payload: { inspection_id: inspectionId, result, notes: notes.trim() },
              })
            }
          >
            {result === 'PASS' ? 'Release to Ready' : 'Record failed check'}
          </Button>
        </>
      }
    >
      <fieldset className="radio-group">
        <legend>Release check result</legend>
        <label className={`radio-card ${result === 'PASS' ? 'checked' : ''}`}>
          <input type="radio" name="result" value="PASS" checked={result === 'PASS'} onChange={() => setResult('PASS')} />
          <span>
            <strong>Pass</strong>
            <span className="muted small block">Inspected and fit for issue. Item becomes Ready.</span>
          </span>
        </label>
        <label className={`radio-card ${result === 'FAIL' ? 'checked' : ''}`}>
          <input type="radio" name="result" value="FAIL" checked={result === 'FAIL'} onChange={() => setResult('FAIL')} />
          <span>
            <strong>Fail</strong>
            <span className="muted small block">Not fit. The item stays unavailable.</span>
          </span>
        </label>
      </fieldset>
      <TextArea label="Inspection notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      <ReceiptNotice outcome={cmd.outcome} />
    </Dialog>
  );
}
