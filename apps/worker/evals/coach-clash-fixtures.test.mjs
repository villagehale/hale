import { describe, expect, it } from 'vitest';
import { COACH_CLASH_FIXTURES } from './coach-clash-fixtures.mjs';

describe('VIL-79 coach clash fixtures', () => {
  it('covers overlap, back-to-back, adult-never and the broken dropped clash', () => {
    expect(COACH_CLASH_FIXTURES.map((f) => f.id)).toEqual([
      'clash-saturday-overlap',
      'clash-back-to-back',
      'clash-adult-overlap-never',
      'clash-dropped',
    ]);
    const dropped = COACH_CLASH_FIXTURES.find((f) => f.id === 'clash-dropped');
    expect(dropped?.clashJudge.shouldPass).toBe(false);
    expect(dropped?.toolResult.result.clashes).toHaveLength(1);
  });

  it('never hands the coach an adult block title, and every event has a real end', () => {
    for (const f of COACH_CLASH_FIXTURES) {
      for (const b of f.calendarBlocks) expect(b.title).toBeNull();
      for (const e of f.events) expect(e.endsAt).not.toBeNull();
      expect(JSON.stringify(f.toolResult)).not.toMatch(/busy/i);
    }
  });
});
