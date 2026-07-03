import { describe, expect, it } from 'vitest';
import { describeCompleteOnboardingError } from './complete-onboarding-copy';

/**
 * completeOnboarding returns machine error codes (tos_required, dob_future, …).
 * The finish button must never render a raw code at the user — every known code
 * maps to a plain sentence, and any unknown code degrades to a safe generic line
 * (never the raw underscore string).
 */
describe('describeCompleteOnboardingError', () => {
  it('renders the ToS gate as a plain instruction, not the raw code', () => {
    const copy = describeCompleteOnboardingError('tos_required');
    expect(copy).not.toContain('tos_required');
    expect(copy).not.toContain('tos required');
    expect(copy.toLowerCase()).toContain('terms');
  });

  it('maps a future date of birth to human copy', () => {
    const copy = describeCompleteOnboardingError('dob_future');
    expect(copy).not.toContain('dob_future');
    expect(copy.toLowerCase()).toContain('future');
  });

  it('maps a missing child to human copy', () => {
    const copy = describeCompleteOnboardingError('name_required');
    expect(copy).not.toContain('name_required');
    expect(copy.toLowerCase()).toContain('child');
  });

  it('never leaks underscores from an unknown code — falls back to a generic line', () => {
    const copy = describeCompleteOnboardingError('some_unmapped_code');
    expect(copy).not.toContain('_');
    expect(copy.length).toBeGreaterThan(0);
  });
});
