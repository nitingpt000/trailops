import { describe, expect, it } from 'vitest';
import { optionsFromChildren } from './Dropdown';

describe('optionsFromChildren', () => {
  it('reads <option> children like a native select, including fragments and conditionals', () => {
    const extra = false;
    const opts = optionsFromChildren(
      <>
        <option value="">All status</option>
        {['READY', 'ISSUED'].map((s) => (
          <option key={s} value={s}>
            {s === 'READY' ? 'Ready' : 'Issued'}
          </option>
        ))}
        {extra && <option value="X">Hidden</option>}
        <option value="RETIRED" disabled>
          Retired
        </option>
      </>,
    );
    expect(opts.map((o) => [o.value, o.text, !!o.disabled])).toEqual([
      ['', 'All status', false],
      ['READY', 'Ready', false],
      ['ISSUED', 'Issued', false],
      ['RETIRED', 'Retired', true],
    ]);
  });

  it('uses the option text as the value when no value is given, and stringifies numbers', () => {
    const opts = optionsFromChildren([<option key="a">Lohajung</option>, <option key="b" value={2}>Second</option>]);
    expect(opts.map((o) => o.value)).toEqual(['Lohajung', '2']);
  });
});
