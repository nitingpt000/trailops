import {canonicalJson, sha256Hex} from '../src/native/sha256';
import {addDays, freshness} from '../src/ui/format';

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(sha256Hex('Kedarkantha · −10°C')).toHaveLength(64);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({b: 1, a: {d: [2, {z: 1, y: 2}], c: undefined}})).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe('format', () => {
  it('adds days across month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
  it('labels stale data', () => {
    const now = Date.UTC(2026, 9, 13, 12);
    expect(freshness(null, now)).toBe('not downloaded yet');
    expect(freshness(now - 30 * 60000, now)).toBe('30 min old');
    expect(freshness(now - 72 * 3600000, now)).toBe('3 days old');
  });
});
