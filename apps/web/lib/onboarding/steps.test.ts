import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEPS,
  activeStepId,
  reachedStepCount,
} from '~/lib/onboarding/steps';

/**
 * The shell's four-step journey indicator. Expectations come from the intended
 * narration: the rail advances one marker per position rather than jumping
 * 1 → 1 → 4, and each label names what that position ACTUALLY collects —
 * intake (A) is "your kids"; the account bridge (B) is "your account"; the C
 * setup form is "the details"; the consent moment / ready interstitial is
 * "in control". (Area and interests are collected inside A, so labelling B/C
 * with them misdescribed the rail.)
 */
describe('onboarding step indicator', () => {
  it('lists the four journey markers in order', () => {
    expect(ONBOARDING_STEPS.map((s) => s.label)).toEqual([
      'your kids',
      'your account',
      'the details',
      'in control',
    ]);
  });

  it('advances one marker per position — intake, account bridge, setup form', () => {
    expect(activeStepId('A')).toBe('kids');
    expect(activeStepId('B')).toBe('area');
    expect(activeStepId('C', 'form')).toBe('matters');
    expect(reachedStepCount('A')).toBe(1);
    expect(reachedStepCount('B')).toBe(2);
    expect(reachedStepCount('C', 'form')).toBe(3);
  });

  it('reaches "in control" only at the consent moment and ready view, not the setup form', () => {
    expect(activeStepId('C', 'control')).toBe('control');
    expect(activeStepId('C', 'ready')).toBe('control');
    expect(reachedStepCount('C', 'control')).toBe(ONBOARDING_STEPS.length);
    expect(activeStepId('C', 'form')).not.toBe('control');
  });
});
