import { describe, expect, it } from 'vitest';
import { REMINDER_FIXTURES } from './reminder-fixtures.mjs';
import { EXPECTED_FAIL, expectedFailGate } from './run-reminder-eval.mjs';

const r = (id, failed) => ({ fixture: { id }, failures: failed ? ['judge:3'] : [] });

describe('reminder cached-only expected-fail gate (VIL-467)', () => {
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
  it('with an empty list every case must pass', () => {
    expect(expectedFailGate([r('a', true)], []).ok).toBe(false);
    expect(expectedFailGate([r('a', false)], []).ok).toBe(true);
  });
  it('is empty: the four #914 cases pass after the VIL-467 re-record', () => {
    expect([...EXPECTED_FAIL]).toEqual([]);
    const ids = REMINDER_FIXTURES.map((f) => f.id);
    for (const id of EXPECTED_FAIL) expect(ids).toContain(id);
  });
});
