/**
 * What a parent is hoping Hale can help with, collected as an optional
 * chip multi-select in onboarding (Phase A) and editable on the Family page.
 * Stored on the family as a nullable text[]; nothing else keys off it yet —
 * it is captured so the product can tailor later.
 *
 * This is the single source of truth: the wizard chips, the settings editor,
 * and server-side validation all read ONBOARDING_INTENTS / OnboardingIntent,
 * so no intent value is a magic string duplicated across the codebase.
 */

export type OnboardingIntent =
  | 'activities'
  | 'childcare'
  | 'milestones'
  | 'planning'
  | 'sitter'
  | 'health'
  | 'community'
  | 'exploring';

/** Ordered list of the selectable intents with their display labels. */
export const ONBOARDING_INTENTS: readonly { value: OnboardingIntent; label: string }[] = [
  { value: 'activities', label: 'Activities & classes' },
  { value: 'childcare', label: 'Childcare (daycare/Montessori/preschool)' },
  { value: 'milestones', label: 'Milestones & development' },
  { value: 'planning', label: 'Weekly planning & routine' },
  { value: 'sitter', label: 'Trusted sitter/nanny' },
  { value: 'health', label: 'Health & specialists' },
  { value: 'community', label: 'Meeting other families' },
  { value: 'exploring', label: 'Just exploring' },
];

const INTENT_VALUES: ReadonlySet<string> = new Set(ONBOARDING_INTENTS.map((i) => i.value));

/** True iff `value` is a known intent. Pure — no I/O. */
export function isOnboardingIntent(value: string): value is OnboardingIntent {
  return INTENT_VALUES.has(value);
}

/**
 * Keep only known intents, de-duplicated, in the canonical ONBOARDING_INTENTS
 * order — so an unknown or repeated value from a client can never be persisted.
 * Pure — no I/O.
 */
export function parseIntents(raw: readonly string[]): OnboardingIntent[] {
  const chosen = new Set(raw.filter(isOnboardingIntent));
  return ONBOARDING_INTENTS.map((i) => i.value).filter((value) => chosen.has(value));
}
