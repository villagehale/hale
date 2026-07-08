/**
 * The onboarding shell's left-rail step indicator — a thematic narration of the
 * journey (mockup register). The wizard's real state machine stays A (intake) / B
 * (account) / C (setup, itself three views: form → control → ready); this maps a
 * (phase, view) position onto which narrative marker reads as "current" so the rail
 * advances as the parent moves, rather than jumping 1 → 1 → 4.
 *
 * A (intake) sits on "your kids"; the B account bridge advances to "your area"
 * (intake is complete behind it); the C setup form is "what matters"; and the
 * consent moment / ready interstitial is "in control", the last thing.
 */

export type OnboardingPhase = 'A' | 'B' | 'C';

/** The C phase's in-place view, mirrored from the wizard so the rail can tell the
 * setup form apart from the consent moment. */
export type OnboardingView = 'form' | 'control' | 'ready';

// Labels name what each POSITION actually collects: Phase A = kids (+ area +
// interests), Phase B = the account, Phase C form = the remaining details,
// C control/ready = consent. Mislabeled markers read as a broken rail.
export const ONBOARDING_STEPS = [
  { id: 'kids', label: 'your kids' },
  { id: 'area', label: 'your account' },
  { id: 'matters', label: 'the details' },
  { id: 'control', label: 'in control' },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];

const STEP_LABELS: Record<OnboardingStepId, string> = Object.fromEntries(
  ONBOARDING_STEPS.map((s) => [s.id, s.label]),
) as Record<OnboardingStepId, string>;

/**
 * The active narrative marker for a (phase, view) position. Intake (A) sits on
 * "your kids"; the account bridge (B) advances to "your area"; the C setup form is
 * "what matters"; the consent moment and ready interstitial are "in control".
 */
export function activeStepId(phase: OnboardingPhase, view: OnboardingView = 'form'): OnboardingStepId {
  if (phase === 'A') {
    return 'kids';
  }
  if (phase === 'B') {
    return 'area';
  }
  return view === 'form' ? 'matters' : 'control';
}

/**
 * How far along a position reads on the rail: the count of markers at or before the
 * active one. Used to render reached-vs-upcoming markers.
 */
export function reachedStepCount(phase: OnboardingPhase, view: OnboardingView = 'form'): number {
  const index = ONBOARDING_STEPS.findIndex((s) => s.id === activeStepId(phase, view));
  return index + 1;
}

/** The label of the currently-active marker — for the compact <lg progress line. */
export function activeStepLabel(phase: OnboardingPhase, view: OnboardingView = 'form'): string {
  return STEP_LABELS[activeStepId(phase, view)];
}
