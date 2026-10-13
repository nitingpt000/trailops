import { describe, expect, it } from 'vitest';
import type { Receipt } from '@trailops/contracts';
import { canonical, describeReceipt, isTerminal, prepareOperation, type Attempt, type CommandDraft } from './commands';

const draft: CommandDraft<'RELEASE_EQUIPMENT'> = {
  type: 'RELEASE_EQUIPMENT',
  aggregate_id: '11111111-1111-4111-8111-111111111111',
  expected_version: 4,
  payload: { inspection_id: '22222222-2222-4222-8222-222222222222', result: 'PASS', notes: '' },
};

let n = 0;
const ids = () => `op-${++n}`;

describe('prepareOperation', () => {
  it('mints an operation with the draft fields and a client observation time', () => {
    const op = prepareOperation(draft, null, () => 'op-a', () => new Date('2026-10-13T08:00:00Z'));
    expect(op).toEqual({
      operation_id: 'op-a',
      type: 'RELEASE_EQUIPMENT',
      aggregate_id: draft.aggregate_id,
      expected_version: 4,
      payload: draft.payload,
      client_recorded_at: '2026-10-13T08:00:00.000Z',
    });
  });

  it('reuses the same operation id when an unsettled submission is retried unchanged', () => {
    const first = prepareOperation(draft, null, ids);
    const attempt: Attempt = { operation: first, settled: false };
    // Same content, different key order: still the same submission.
    const reordered = { ...draft, payload: { notes: '', result: 'PASS' as const, inspection_id: draft.payload.inspection_id } };
    const retry = prepareOperation(reordered, attempt, ids);
    expect(retry).toBe(first);
    expect(retry.operation_id).toBe(first.operation_id);
    expect(retry.client_recorded_at).toBe(first.client_recorded_at);
  });

  it('mints a new id once the previous submission reached a terminal receipt', () => {
    const first = prepareOperation(draft, null, ids);
    const next = prepareOperation(draft, { operation: first, settled: true }, ids);
    expect(next.operation_id).not.toBe(first.operation_id);
  });

  it('mints a new id when the submission changed (the server would reject id reuse)', () => {
    const first = prepareOperation(draft, null, ids);
    const changed = prepareOperation({ ...draft, payload: { ...draft.payload, result: 'FAIL' } }, { operation: first, settled: false }, ids);
    expect(changed.operation_id).not.toBe(first.operation_id);
    const newVersion = prepareOperation({ ...draft, expected_version: 5 }, { operation: first, settled: false }, ids);
    expect(newVersion.operation_id).not.toBe(first.operation_id);
  });

  it('includes preconditions only when present and omits null expected_version', () => {
    const op = prepareOperation(
      {
        type: 'DISPATCH_TRANSFER',
        aggregate_id: 't-1',
        expected_version: null,
        preconditions: [{ entity: 'equipment', id: 'i-1', expected_version: 3 }],
        payload: { from_location_id: 'a', to_location_id: 'b', item_ids: ['i-1'] },
      },
      null,
      ids,
    );
    expect(op.preconditions).toEqual([{ entity: 'equipment', id: 'i-1', expected_version: 3 }]);
    expect('expected_version' in op).toBe(false);
  });
});

describe('canonical', () => {
  it('is key-order independent and drops undefined', () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(canonical({ a: [{ z: null, y: 2 }], b: 1 }));
  });
});

const receipt = (r: Partial<Receipt>): Receipt => ({ operation_id: 'op', status: 'ACCEPTED', code: null, message: null, retryable: false, ...r });

describe('describeReceipt', () => {
  it('maps ACCEPTED and replayed receipts', () => {
    expect(describeReceipt(receipt({})).tone).toBe('success');
    const replay = describeReceipt(receipt({ replayed: true }));
    expect(replay.title).toBe('Already recorded');
  });

  it('explains VERSION_CONFLICT as changed-since-loaded and asks for a refresh', () => {
    const v = describeReceipt(
      receipt({ status: 'CONFLICT', code: 'VERSION_CONFLICT', message: 'This repair changed since it was downloaded. Refresh and review.' }),
    );
    expect(v.tone).toBe('warning');
    expect(v.title).toBe('Changed since you loaded it');
    expect(v.refresh).toBe(true);
    expect(v.message).toContain('This repair changed since it was downloaded');
  });

  it('keeps the server message for EVIDENCE_PENDING and adds the blocking explanation', () => {
    const v = describeReceipt(receipt({ status: 'CONFLICT', code: 'EVIDENCE_PENDING', message: 'Photos for this inspection have not been verified yet.' }));
    expect(v.message).toMatch(/^Photos for this inspection have not been verified yet\./);
    expect(v.message).toContain('blocked');
    expect(v.refresh).toBe(false);
  });

  it('surfaces REJECTED messages with field errors, and 403 as not permitted', () => {
    const v = describeReceipt(
      receipt({ status: 'REJECTED', code: 'INVALID_INPUT', message: 'The command payload is invalid.', field_errors: { 'replacement.due_date': 'Input should be a valid date' } }),
    );
    expect(v.tone).toBe('error');
    expect(v.fieldErrors).toEqual({ 'replacement.due_date': 'Input should be a valid date' });
    expect(describeReceipt(receipt({ status: 'REJECTED', code: 'FORBIDDEN', message: 'Missing permission', http_status: 403 })).title).toBe('Not permitted');
  });

  it('treats RETRY and DEPENDENCY_PENDING as retryable, non-terminal', () => {
    const retry = receipt({ status: 'RETRY', code: 'TRANSIENT', retryable: true });
    expect(isTerminal(retry)).toBe(false);
    expect(describeReceipt(retry).retryable).toBe(true);
    expect(isTerminal(receipt({ status: 'DEPENDENCY_PENDING' }))).toBe(false);
    expect(isTerminal(receipt({ status: 'CONFLICT' }))).toBe(true);
  });
});
