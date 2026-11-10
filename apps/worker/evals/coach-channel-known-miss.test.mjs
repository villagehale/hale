import { describe, expect, it } from 'vitest';
import { knownMissState } from './coach-channel-known-miss.mjs';

const marked = {
  expect: { knownMiss: { ticket: 'VIL-652', failure: 'questions in one message' } },
};
const unmarked = { expect: {} };

describe('knownMissState', () => {
  it('covers a marked fixture that fails only the named check', () => {
    expect(knownMissState(marked, ['2 questions in one message (at most one)'])).toBe('covered');
  });

  it('does not cover a marked fixture that also fails something else', () => {
    expect(
      knownMissState(marked, [
        '2 questions in one message (at most one)',
        'FABRICATION: name "Marcus" is in no fact',
      ]),
    ).toBe('uncovered');
    expect(knownMissState(marked, ['FABRICATION: name "Marcus" is in no fact'])).toBe('uncovered');
  });

  it('calls a marked fixture that passes stale, so the marker comes off', () => {
    expect(knownMissState(marked, [])).toBe('stale');
  });

  it('leaves an unmarked fixture alone', () => {
    expect(knownMissState(unmarked, ['2 questions in one message (at most one)'])).toBe('none');
    expect(knownMissState(unmarked, [])).toBe('none');
  });
});
