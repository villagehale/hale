import { describe, expect, it } from 'vitest';
import { COACH_EVAL_N_OF_M_ENABLED_ENV, coachEvalNOfMEnabled } from './coach-eval-n-of-m-flag.mjs';

describe('coachEvalNOfMEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('stays off for every other value, including a trailing newline and unset', () => {
    expect(coachEvalNOfMEnabled({})).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: '' })).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: '1' })).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: 'on' })).toBe(false);
    expect(coachEvalNOfMEnabled({ [COACH_EVAL_N_OF_M_ENABLED_ENV]: 'false' })).toBe(false);
  });
});
