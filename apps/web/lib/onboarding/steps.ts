/**
 * The nine-step web onboarding model (design handoff §4.1). The wizard is a linear
 * step machine 1..9; this is the single source of truth for the step ids, their
 * accessible labels, and the count that drives the segmented progress bar.
 *
 * Data-collection reality (rule #1): steps 1–6 run PRE-AUTH on the public
 * /onboarding route and stash only NON-sensitive intake (first names, a coarse
 * city, intents) in the browser; a child's date of birth is collected only at
 * step 7, POST-AUTH, so sensitive data never lives in browser storage before the
 * account exists. See wizard.tsx for how each step maps onto the persisted mutation.
 */

export const ONBOARDING_STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'tomorrow', label: "Here's tomorrow" },
  { id: 'children', label: 'Your children' },
  { id: 'location', label: 'Your village area' },
  { id: 'matters', label: 'What matters' },
  { id: 'auth', label: 'Save your village' },
  { id: 'ready', label: 'Getting ready' },
  { id: 'connect', label: 'Connect apps' },
  { id: 'done', label: 'Village ready' },
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepId = OnboardingStep['id'];

/** The number of steps — the segmented progress bar renders exactly this many. */
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/** The first step that requires a signed-in session (the auth hop lands here). */
export const FIRST_POST_AUTH_STEP = 7;

/** Clamp any candidate step index into the valid 1..count range. */
export function clampStep(n: number): number {
  if (n < 1) return 1;
  if (n > ONBOARDING_STEP_COUNT) return ONBOARDING_STEP_COUNT;
  return Math.trunc(n);
}

/** The accessible label for a 1-indexed step, for the progress bar's live region. */
export function stepLabel(step: number): string {
  const entry = ONBOARDING_STEPS[clampStep(step) - 1];
  return entry ? entry.label : ONBOARDING_STEPS[0].label;
}
