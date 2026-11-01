import { describe, expect, it } from 'vitest';
import { EXPECTED_FAIL, expectedFailGate } from './said-line-expected-fail.mjs';
import { SAID_LINE_FIXTURES } from './said-line-fixtures.mjs';

const r = (id, failed) => ({ id, failed });

describe('said-line cached-only expected-fail gate (VIL-467)', () => {
  it('passes when only listed cases fail', () => {
    const g = expectedFailGate([r('a', true), r('b', false)], ['a']);
    expect(g.ok).toBe(true);
    expect(g.expectedFailed).toEqual(['a']);
  });
  it('fails on any unlisted failure', () => {
    const g = expectedFailGate([r('a', true), r('b', true)], ['a']);
    expect(g.ok).toBe(false);
    expect(g.unexpectedFail).toEqual(['b']);
  });
  it('fails when a listed case starts passing', () => {
    const g = expectedFailGate([r('a', false), r('b', false)], ['a']);
    expect(g.ok).toBe(false);
    expect(g.unexpectedPass).toEqual(['a']);
    expect(g.lines.join('\n')).toMatch(/remove it from EXPECTED_FAIL/);
  });
  it('fails when the list names an unknown case', () => {
    const g = expectedFailGate([r('a', false)], ['gone']);
    expect(g.ok).toBe(false);
    expect(g.unknown).toEqual(['gone']);
  });
  it('a listed fixture filtered out of the run is known, not unknown', () => {
    const g = expectedFailGate([r('b', false)], ['a'], ['a', 'b']);
    expect(g.ok).toBe(true);
  });
  it('with an empty list (live runs) every case must pass', () => {
    expect(expectedFailGate([r('a', true)], []).ok).toBe(false);
    expect(expectedFailGate([r('a', false)], []).ok).toBe(true);
  });
  it('lists only intro-no-open-fr, a real fixture', () => {
    expect([...EXPECTED_FAIL]).toEqual(['intro-no-open-fr']);
    expect(SAID_LINE_FIXTURES.map((f) => f.id)).toContain('intro-no-open-fr');
  });
});
