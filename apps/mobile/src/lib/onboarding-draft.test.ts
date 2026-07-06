import { describe, expect, it } from 'vitest';

import { type OnboardingDraft, draftToOnboardingInput, emptyDraft } from './onboarding-draft';

/**
 * The intake → onboarding-request mapping. This is the security-sensitive seam:
 * the request body it produces is what /api/mobile/onboarding forwards to the
 * SHARED completeOnboarding (children + consent + Canada gate). Expected values are
 * derived from the wire contract (trim names, coarse location only, drop empties),
 * not copied from the function's output. The secure-store round-trip isn't tested
 * here — it needs the native Keychain, which the pure-logic vitest runner lacks.
 */

const draft = (over: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...emptyDraft(),
  ...over,
});

describe('draftToOnboardingInput', () => {
  it('trims child names and preserves the YYYY-MM-DD date of birth', () => {
    const input = draftToOnboardingInput(
      draft({ children: [{ name: '  Maya  ', dateOfBirth: '2023-04-01' }] }),
    );
    expect(input.children).toEqual([{ name: 'Maya', dateOfBirth: '2023-04-01' }]);
  });

  it('carries tosAccepted and the chosen plan tier through unchanged', () => {
    const input = draftToOnboardingInput(draft({ planTier: 'plus', tosAccepted: true }));
    expect(input.tosAccepted).toBe(true);
    expect(input.planTier).toBe('plus');
  });

  it('omits location entirely when no coarse fields are set', () => {
    const input = draftToOnboardingInput(draft({ location: {} }));
    expect(input.location).toBeUndefined();
  });

  it('sends only the coarse location fields, trimmed (rule #1 — no precise address)', () => {
    const input = draftToOnboardingInput(
      draft({ location: { city: '  Toronto ', postalCode: ' M5V 2T6 ' } }),
    );
    expect(input.location).toEqual({ city: 'Toronto', postalCode: 'M5V 2T6' });
  });

  it('drops a blank city/postal so an all-whitespace entry never becomes a location', () => {
    const input = draftToOnboardingInput(draft({ location: { city: '   ', postalCode: '' } }));
    expect(input.location).toBeUndefined();
  });

  it('omits intents when none are selected, and forwards them when present', () => {
    expect(draftToOnboardingInput(draft({ intents: [] })).intents).toBeUndefined();
    expect(draftToOnboardingInput(draft({ intents: ['activities', 'health'] })).intents).toEqual([
      'activities',
      'health',
    ]);
  });
});
