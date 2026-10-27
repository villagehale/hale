import { describe, expect, it } from 'vitest';
import { brokenFooter } from './run-reminder-eval.mjs';

const r = (id, kind, failed) => ({ fixture: { id }, kind, failures: failed ? ['judge:2'] : [] });

describe('reminder --broken footer', () => {
  it('does not count a passing normal case as a broken case that slipped', () => {
    const f = brokenFooter([r('en-teen-generic', 'normal', false), r('x:notification', 'broken', true)]);
    expect(f.calibrated).toBe(true);
    expect(f.slipped).toEqual([]);
    expect(f.ok).toBe(true);
    expect(f.lines[0]).toMatch(/1 broken cases.*PASS/);
    expect(f.lines[1]).toMatch(/normal cases \(1.*PASS/);
  });
  it('fails calibration when a broken case passes', () => {
    const f = brokenFooter([r('x:wish', 'broken', false), r('y:unnatural', 'broken', true)]);
    expect(f.calibrated).toBe(false);
    expect(f.slipped).toEqual(['x:wish']);
    expect(f.ok).toBe(false);
  });
  it('reports a failing normal case as a normal failure, not calibration', () => {
    const f = brokenFooter([r('fr-all-day-plus-timed', 'normal', true), r('x:wish', 'broken', true)]);
    expect(f.calibrated).toBe(true);
    expect(f.normalFailed).toEqual(['fr-all-day-plus-timed']);
    expect(f.ok).toBe(false);
  });
  it('a deterministic stand-in on a fixture is a broken case', () => {
    const f = brokenFooter([r('en-pd-day-timed', 'broken', true)]);
    expect(f.ok).toBe(true);
    expect(f.lines).toHaveLength(1);
  });
});
