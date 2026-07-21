import { describe, expect, it } from 'vitest';
import type { IntakeDraft } from '~/lib/onboarding/intake-storage';
import { decideOnboardingEntry, resumeFromDraft } from '~/lib/onboarding/resume';

/**
 * The two decisions a /onboarding visit turns on, pulled out of the async page /
 * client effect so they can be checked without mocking auth, the DB, or the DOM:
 * where the visit LANDS (already-onboarded card vs the wizard) and how the wizard
 * REHYDRATES the pre-auth draft (including the fresh-tab magic link, where there is
 * no draft at all).
 */

describe('decideOnboardingEntry — where a /onboarding visit lands', () => {
  it('shows the honest terminal card to a signed-in parent who already has a family', () => {
    // The founder hit the old silent bounce to /home while testing with his own
    // (onboarded) account — it read as the flow ending mid-wizard. The card names
    // what happened instead of redirecting invisibly.
    expect(decideOnboardingEntry(true, true)).toEqual({ kind: 'already-onboarded' });
  });

  it('resumes a signed-in, family-less parent inside the wizard (post-auth)', () => {
    expect(decideOnboardingEntry(true, false)).toEqual({ kind: 'wizard', signedIn: true });
  });

  it('starts a signed-out visitor at the top of the wizard', () => {
    expect(decideOnboardingEntry(false, false)).toEqual({ kind: 'wizard', signedIn: false });
  });
});

describe('resumeFromDraft — rehydrating the wizard after the auth hop', () => {
  const draft = (over: Partial<IntakeDraft> = {}): IntakeDraft => ({
    childNames: [],
    city: '',
    intents: [],
    planTier: 'free',
    tosAccepted: false,
    ...over,
  });

  it('falls back to empty fields when the tab has no draft (fresh-tab magic link)', () => {
    // A magic link opened in a new tab / another device carries no sessionStorage
    // draft; step 7 must still be reachable and collect name + birthday + area fresh.
    expect(resumeFromDraft(null)).toEqual({ childNames: [], area: '', intents: [] });
  });

  it('carries the child names, area, and intents the parent gave pre-auth', () => {
    const state = resumeFromDraft(
      draft({ childNames: ['Sebastian', 'Mira'], city: 'Toronto', intents: ['sleep'] }),
    );
    expect(state.childNames).toEqual(['Sebastian', 'Mira']);
    expect(state.area).toBe('Toronto');
    expect(state.intents).toEqual(['sleep']);
  });

  it('drops blank / whitespace-only child rows so no nameless child is seeded', () => {
    expect(resumeFromDraft(draft({ childNames: ['  ', 'Ada', ''] })).childNames).toEqual(['Ada']);
  });

  it('ignores unknown intent values from a stale or tampered draft', () => {
    expect(resumeFromDraft(draft({ intents: ['sleep', 'not-a-real-intent'] })).intents).toEqual([
      'sleep',
    ]);
  });
});
