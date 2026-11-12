import { describe, expect, it } from 'vitest';
import { gradeHoldingLineJudge } from './holding-line-judge-fixtures.mjs';

describe('holding-line judge extra refusals (Devin #1003)', () => {
  it('passes a time-only line only when the place axis is no', () => {
    expect(
      gradeHoldingLineJudge({ promises_a_time: 'yes', points_at_an_app: 'no' }, 'promised_a_time'),
    ).toBeNull();
    expect(
      gradeHoldingLineJudge({ promises_a_time: 'yes', points_at_an_app: 'yes' }, 'promised_a_time'),
    ).toBe('judge also refused a place on a time-only line (place=yes)');
  });

  it('passes a place-only line only when the time axis is no', () => {
    expect(
      gradeHoldingLineJudge({ promises_a_time: 'no', points_at_an_app: 'yes' }, 'points_at_an_app'),
    ).toBeNull();
    expect(
      gradeHoldingLineJudge(
        { promises_a_time: 'yes', points_at_an_app: 'yes' },
        'points_at_an_app',
      ),
    ).toBe('judge also refused a time on a place-only line (time=yes)');
  });

  it('still requires both yes on a both line, and both no on a clear line', () => {
    expect(
      gradeHoldingLineJudge({ promises_a_time: 'yes', points_at_an_app: 'yes' }, 'both'),
    ).toBeNull();
    expect(
      gradeHoldingLineJudge({ promises_a_time: 'no', points_at_an_app: 'no' }, 'clear'),
    ).toBeNull();
  });
});
