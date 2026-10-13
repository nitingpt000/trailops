import { describe, expect, it } from 'vitest';
import schemaCases from '../fixtures/forms/schema-cases.json';
import answerCases from '../fixtures/forms/answer-cases.json';
import { validateAnswers, validateSchema, pruneHidden, type FormSchema } from '../src/forms';
import { encodeEquipmentLabel, parseEquipmentLabel } from '../src/qr';
import { retryDelayMs } from '../src/commands';

function applyPatch(base: unknown, patch: Record<string, unknown> | null): unknown {
  const doc = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch ?? {})) {
    const parts = path.split('.');
    let target: any = doc;
    for (const p of parts.slice(0, -1)) target = Array.isArray(target) ? target[Number(p)] : target[p];
    const last = parts[parts.length - 1];
    if (Array.isArray(target)) {
      if (value === null) target.splice(Number(last), 1);
      else target[Number(last)] = value;
    } else target[last] = value;
  }
  return doc;
}

describe('shared form fixtures (same cases as the Python engine)', () => {
  for (const c of schemaCases.cases) {
    it(`schema: ${c.name}`, () => {
      const errors = validateSchema(applyPatch(schemaCases.base, c.patch as Record<string, unknown> | null));
      expect(Object.keys(errors).sort()).toEqual([...c.errors].sort());
    });
  }
  for (const c of answerCases.cases) {
    it(`answers: ${c.name}`, () => {
      const answers = Object.fromEntries(
        Object.entries(c.answers).map(([k, v]) => [k, v === '@@LONG@@' ? 'x'.repeat(501) : v]),
      );
      const errors = validateAnswers(schemaCases.base as FormSchema, answers, new Set(c.attachments));
      expect(Object.keys(errors).sort()).toEqual([...c.errors].sort());
    });
  }
  it('prunes hidden answers before submission', () => {
    const pruned = pruneHidden(schemaCases.base as FormSchema, { condition: 'GOOD', issue_type: 'TEAR', notes: '' });
    expect(pruned).toEqual({ condition: 'GOOD' });
  });
});

describe('QR labels', () => {
  const id = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  it('round-trips with checksum', () => {
    expect(parseEquipmentLabel(encodeEquipmentLabel(id))).toEqual({ ok: true, id });
  });
  it('rejects wrong prefix, bad id, bad checksum, oversized payload', () => {
    expect(parseEquipmentLabel('https://evil.example/' + id)).toEqual({ ok: false, reason: 'WRONG_PREFIX' });
    expect(parseEquipmentLabel('trailops:v1:equipment:JKT-014')).toEqual({ ok: false, reason: 'INVALID_ID' });
    expect(parseEquipmentLabel(`trailops:v1:equipment:${id}:zz`)).toEqual({ ok: false, reason: 'BAD_CHECKSUM' });
    expect(parseEquipmentLabel('trailops:v1:equipment:' + 'a'.repeat(200))).toEqual({ ok: false, reason: 'TOO_LONG' });
  });
});

describe('retry schedule', () => {
  it('follows 2s, 5s, 15s, 60s then caps at 5 min with jitter', () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => retryDelayMs(a, () => 0.5))).toEqual([2000, 5000, 15000, 60000, 300000, 300000]);
    expect(retryDelayMs(0, () => 0)).toBe(1600);
  });
});
