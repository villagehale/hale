import { describe, expect, it } from 'vitest';
import {
  JUDGE_DRAWS,
  JUDGE_MAX_TOKENS,
  READ_ATTEMPTS,
  VOICE_ATTEMPTS,
  formatEstimate,
  priced,
  suiteBreakdown,
} from './carpool-estimate.mjs';
import { CARPOOL_JUDGE_CASES } from './carpool-judge-fixtures.mjs';
import { PRICE } from './lib/harness.mjs';

const HAIKU = 'claude-haiku-5-5';
const OPUS = 'claude-opus-5-5';

describe('carpool dry estimate', () => {
  const breakdown = suiteBreakdown({
    readModel: HAIKU,
    voiceModel: HAIKU,
    judgeModel: HAIKU,
    readingInstructions: 'read the drive',
    voiceInstructions: 'write one line',
    readingTool: { type: 'object' },
    judgeSystem: 'score meaning 1-5',
    judgeSchema: { type: 'object' },
  });

  it('prices a judge call for every ticket case, not only reader and voice', () => {
    const expected = CARPOOL_JUDGE_CASES.length * (READ_ATTEMPTS + VOICE_ATTEMPTS + JUDGE_DRAWS);
    expect(breakdown.rows).toHaveLength(expected);
    expect(breakdown.byRole.judge.calls).toBe(CARPOOL_JUDGE_CASES.length * JUDGE_DRAWS);
    expect(breakdown.byRole.judge.model).toBe(HAIKU);
    expect(breakdown.byRole.judge.usd).toBeGreaterThan(0);
  });

  it('sums per-call USD to the total', () => {
    const sum = breakdown.rows.reduce((usd, row) => usd + row.usd, 0);
    expect(breakdown.usd).toBeCloseTo(sum, 10);
    expect(breakdown.usd).toBeGreaterThan(0);
  });

  it('prices judge output at the judge max, on Haiku list rates', () => {
    const judge = breakdown.rows.filter((row) => row.role === 'judge');
    expect(judge.every((row) => row.output === JUDGE_MAX_TOKENS)).toBe(true);
    const one = judge[0];
    expect(one.usd).toBeCloseTo(priced(HAIKU, one.input, JUDGE_MAX_TOKENS), 10);
    expect(PRICE[HAIKU]).toEqual({ input: 0.1, output: 0.5 });
  });

  it('prints every call, including the four judge lines', () => {
    const printed = formatEstimate(breakdown);
    expect(printed).toMatch(/judge \$/);
    for (const fixture of CARPOOL_JUDGE_CASES) {
      expect(printed).toContain(`${fixture.id}  judge  ${HAIKU}`);
    }
  });

  it('is much cheaper on Haiku judge than the same calls on Opus', () => {
    const opus = suiteBreakdown({
      readModel: HAIKU,
      voiceModel: HAIKU,
      judgeModel: OPUS,
      readingInstructions: 'read the drive',
      voiceInstructions: 'write one line',
      readingTool: { type: 'object' },
      judgeSystem: 'score meaning 1-5',
      judgeSchema: { type: 'object' },
    });
    expect(opus.byRole.judge.usd).toBeGreaterThan(breakdown.byRole.judge.usd * 20);
  });
});
