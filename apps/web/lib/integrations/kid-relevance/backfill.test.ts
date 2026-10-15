import { describe, expect, it } from 'vitest';
import { CALENDAR_MIRROR_HONOURS_KID_VERDICTS, backfillApplyDecision } from './backfill';

/**
 * Whether the backfill script may write. An apply drops a calendar copy the mirror would
 * put straight back, so it is refused, by name, until the mirror reads the verdict.
 */
describe('backfillApplyDecision', () => {
  it('refuses an apply while the calendar mirror does not honour a dropped copy', () => {
    expect(backfillApplyDecision({ apply: true, revert: false }, false)).toEqual({
      outcome: 'mirror_not_wired',
      reason: expect.stringMatching(/^[^\n]*calendar mirror[^\n]*$/),
    });
  });

  it('allows an apply once the mirror honours it', () => {
    expect(backfillApplyDecision({ apply: true, revert: false }, true)).toEqual({
      outcome: 'allowed',
    });
  });

  it('never refuses a dry run or a revert', () => {
    expect(backfillApplyDecision({ apply: false, revert: false }, false)).toEqual({
      outcome: 'allowed',
    });
    expect(backfillApplyDecision({ apply: false, revert: true }, false)).toEqual({
      outcome: 'allowed',
    });
    expect(backfillApplyDecision({ apply: true, revert: true }, false)).toEqual({
      outcome: 'allowed',
    });
  });

  it('the mirror is not wired yet, so the script refuses an apply today', () => {
    expect(
      backfillApplyDecision({ apply: true, revert: false }, CALENDAR_MIRROR_HONOURS_KID_VERDICTS)
        .outcome,
    ).toBe('mirror_not_wired');
  });
});
