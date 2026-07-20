import { describe, expect, it } from 'vitest';
import {
  FIRST_POST_AUTH_STEP,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  clampStep,
  stepLabel,
} from '~/lib/onboarding/steps';

/**
 * The nine-step web onboarding model (design handoff §4.1). Expectations come from
 * the spec, not from the array itself: nine steps in the handoff's order, the auth
 * hop landing at step 7 (the first post-auth step), and the clamp/label helpers
 * that drive the segmented progress bar staying inside 1..9.
 */
describe('onboarding steps model', () => {
  it('has exactly nine steps, in the handoff order', () => {
    expect(ONBOARDING_STEP_COUNT).toBe(9);
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual([
      'welcome',
      'tomorrow',
      'children',
      'location',
      'matters',
      'auth',
      'ready',
      'connect',
      'done',
    ]);
  });

  it('resumes at step 7 after the auth hop (first post-auth step)', () => {
    // Steps 1–6 are pre-auth; the sensitive detail (DOB) + provisioning happen at
    // step 7, so that is where a returning signed-in parent lands.
    expect(FIRST_POST_AUTH_STEP).toBe(7);
    expect(ONBOARDING_STEPS[6].id).toBe('ready');
  });

  it('clamps a candidate step into the valid 1..9 range', () => {
    expect(clampStep(0)).toBe(1);
    expect(clampStep(-4)).toBe(1);
    expect(clampStep(1)).toBe(1);
    expect(clampStep(9)).toBe(9);
    expect(clampStep(12)).toBe(9);
    expect(clampStep(4.7)).toBe(4);
  });

  it('labels a 1-indexed step and clamps out-of-range lookups', () => {
    expect(stepLabel(1)).toBe('Welcome');
    expect(stepLabel(6)).toBe('Save your village');
    expect(stepLabel(9)).toBe('Village ready');
    expect(stepLabel(99)).toBe('Village ready');
  });
});
