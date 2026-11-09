import { describe, expect, it } from 'vitest';
import { PROD_TURN_MEDIAN_MS, PROD_TURN_P95_MS, buildProbePlan, sampleTurnMs } from './plan';
import { percentile } from './report';

const base = {
  families: 100,
  windowMs: 600_000,
  textsPerFamily: 1,
  followUpGapMs: 20_000,
  burstShare: 0,
  burstMs: 60_000,
  turnCapMs: 90_000,
  seed: 314,
};

describe('buildProbePlan', () => {
  it('lands every first text inside the window, one per family', () => {
    const plan = buildProbePlan(base);
    expect(plan).toHaveLength(100);
    expect(new Set(plan.map((a) => a.family)).size).toBe(100);
    expect(plan.every((a) => a.atMs >= 0 && a.atMs < 600_000)).toBe(true);
    // Spread, not bunched: both halves of the window carry texts.
    expect(plan.filter((a) => a.atMs < 300_000).length).toBeGreaterThan(30);
    expect(plan.filter((a) => a.atMs >= 300_000).length).toBeGreaterThan(30);
  });

  it('puts the burst share of first texts inside the burst', () => {
    const plan = buildProbePlan({ ...base, burstShare: 0.6 });
    const inBurst = plan.filter((a) => a.atMs < 60_000).length;
    // 60% burst plus the tenth of the spread texts that land there anyway.
    expect(inBurst).toBeGreaterThan(50);
    expect(buildProbePlan(base).filter((a) => a.atMs < 60_000).length).toBeLessThan(25);
  });

  it('chains a family’s later texts behind its earlier turns', () => {
    const plan = buildProbePlan({ ...base, families: 3, textsPerFamily: 3 });
    expect(plan).toHaveLength(9);
    for (const family of [0, 1, 2]) {
      const texts = plan.filter((a) => a.family === family);
      for (let i = 1; i < texts.length; i += 1) {
        const prev = texts[i - 1];
        const cur = texts[i];
        if (!prev || !cur) throw new Error('missing text');
        expect(cur.atMs).toBe(prev.atMs + prev.turnMs + 20_000);
      }
    }
  });

  it('is the same plan for the same seed and a different one for another', () => {
    expect(buildProbePlan(base)).toEqual(buildProbePlan(base));
    expect(buildProbePlan({ ...base, seed: 315 })).not.toEqual(buildProbePlan(base));
  });

  it('refuses a plan with no families', () => {
    expect(() => buildProbePlan({ ...base, families: 0 })).toThrow(/families/);
  });
});

describe('sampleTurnMs', () => {
  it('reproduces production turn times and never passes the turn deadline', () => {
    let state = 1;
    const next = () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const samples = Array.from({ length: 4000 }, () => sampleTurnMs(next, 90_000));
    const p50 = percentile(samples, 50) ?? 0;
    const p95 = percentile(samples, 95) ?? 0;
    expect(Math.abs(p50 - PROD_TURN_MEDIAN_MS)).toBeLessThan(3_000);
    expect(Math.abs(p95 - PROD_TURN_P95_MS)).toBeLessThan(5_000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(90_000);
  });
});
