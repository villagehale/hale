import { describe, expect, it } from 'vitest';
import { namesAny } from './teen-name.js';

/**
 * VIL-634. The shared matcher: NFKD fold, format characters dropped, every name
 * part of two or more letters, whole word. Positive control first.
 */

const TEEN = ['Tamsin'];

describe('namesAny', () => {
  it('hits a stored name as a whole word (positive control)', () => {
    expect(namesAny('Tamsin has debate', TEEN)).toBe(true);
  });

  it.each([
    ['another case', 'tAMSIN has debate', TEEN],
    ['accents', 'Támsin has debate', TEEN],
    ['a format character splitting the letters', 'Ta\u200Bmsin has debate', TEEN],
    ['a name part of a two-word given name', 'Sofia has debate', ['Ana Sofia']],
    ['after a newline', 'quick one\nTamsin got detention', TEEN],
  ] as const)('names the teen: %s', (_label, text, names) => {
    expect(namesAny(text, names)).toBe(true);
  });

  it.each([
    ['a name inside a longer word', 'Tamsinfield road', TEEN],
    ['a one-letter part', 'A has debate', ['A']],
    ['no name', 'library on Sundays', TEEN],
  ] as const)('passes %s', (_label, text, names) => {
    expect(namesAny(text, names)).toBe(false);
  });

  it('names no one when the family has no teen', () => {
    expect(namesAny('Tamsin', [])).toBe(false);
  });

  /**
   * Trade-off, written down: the matcher does not skip enum-shaped strings. A
   * child stored as "preference" is named by the fact-type enum value
   * "preference", and the row is withheld. Fail closed (rule #1).
   */
  it('a child whose name equals an enum value is a hit (evasion table)', () => {
    expect(namesAny('preference', ['preference'])).toBe(true);
    expect(namesAny('logistic', ['Tamsin'])).toBe(false);
  });
});
