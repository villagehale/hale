import { type OnboardingIntent, parseIntents } from '@hale/types';
import type { IntakeDraft } from '~/lib/onboarding/intake-storage';

/**
 * Where a visit to /onboarding lands, given the session + family facts the server
 * resolves. A signed-in parent who already has a family has nothing to onboard, so
 * instead of a silent bounce to /home — which reads as the flow ending mid-wizard,
 * the way the founder hit it testing with his own account — they get an honest
 * terminal card. Everyone else enters the wizard: a fresh visitor at step 1, a
 * signed-in-but-family-less parent resumed at the first post-auth step.
 */
export type OnboardingEntry =
  | { kind: 'already-onboarded' }
  | { kind: 'wizard'; signedIn: boolean };

export function decideOnboardingEntry(hasSession: boolean, hasFamily: boolean): OnboardingEntry {
  if (hasSession && hasFamily) {
    return { kind: 'already-onboarded' };
  }
  return { kind: 'wizard', signedIn: hasSession };
}

/** The pre-auth draft projected onto the wizard's post-auth initial fields. */
export interface ResumeState {
  childNames: string[];
  area: string;
  intents: OnboardingIntent[];
}

/**
 * Rehydrate the wizard from the tab-scoped intake draft after the auth hop. The
 * draft lives in sessionStorage, so a magic link opened in a fresh tab (or on
 * another device) arrives with no draft at all — every field then falls back to its
 * empty default and step 7 collects name + birthday + area from scratch, losing
 * nothing. Blank child rows are dropped so a stray empty name never seeds a
 * nameless child, and unknown intents are filtered (a stale or tampered draft).
 */
export function resumeFromDraft(draft: IntakeDraft | null): ResumeState {
  if (!draft) {
    return { childNames: [], area: '', intents: [] };
  }
  return {
    childNames: draft.childNames.map((name) => name.trim()).filter((name) => name.length > 0),
    area: draft.city,
    intents: parseIntents(draft.intents ?? []),
  };
}
