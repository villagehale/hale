/**
 * The local onboarding DRAFT — the intake a parent fills in before their account
 * exists — plus its pure mapping to the onboarding request body. Kept free of
 * native imports so the security-sensitive mapping is unit-testable under the
 * pure-logic vitest runner; the persistence lives in onboarding-draft-store.ts.
 *
 * The draft contains a child's first name + full date of birth (rule #1 —
 * sensitive; the store persists it in the Keychain/Keystore and it is never logged).
 */

/** A child as collected in the intake — a first name and a `YYYY-MM-DD` DOB. */
export interface DraftChild {
  name: string;
  dateOfBirth: string;
}

/** Coarse location only (rule #1) — never a precise street address. */
export interface DraftLocation {
  city?: string;
  postalCode?: string;
}

export type DraftPlanTier = 'free' | 'plus' | 'family';

/** Everything the intake collects, kept as the wire-ready draft. */
export interface OnboardingDraft {
  children: DraftChild[];
  location: DraftLocation;
  intents: string[];
  planTier: DraftPlanTier;
  tosAccepted: boolean;
}

/**
 * The request body /api/mobile/onboarding expects — mirrored from the web
 * CompleteOnboardingInput (apps/web/lib/onboarding/complete-onboarding.ts). The
 * native bundle can't import server code, so this is hand-copied like api-types.ts.
 */
export interface OnboardingInput {
  children: { name: string; dateOfBirth: string }[];
  planTier: DraftPlanTier;
  tosAccepted: boolean;
  location?: { city?: string; postalCode?: string };
  intents?: string[];
}

export function emptyDraft(): OnboardingDraft {
  return { children: [], location: {}, intents: [], planTier: 'free', tosAccepted: false };
}

/**
 * Map the draft to the onboarding request body. Empty location fields and an empty
 * intent list are dropped so the server sees `undefined` (its own normalization
 * treats absent and empty the same); the draft's own consent flag becomes
 * tosAccepted, which the server re-validates before recording the 4 consents.
 */
export function draftToOnboardingInput(draft: OnboardingDraft): OnboardingInput {
  const location: DraftLocation = {};
  if (draft.location.city?.trim()) location.city = draft.location.city.trim();
  if (draft.location.postalCode?.trim()) location.postalCode = draft.location.postalCode.trim();

  return {
    children: draft.children.map((child) => ({
      name: child.name.trim(),
      dateOfBirth: child.dateOfBirth,
    })),
    planTier: draft.planTier,
    tosAccepted: draft.tosAccepted,
    ...(Object.keys(location).length > 0 ? { location } : {}),
    ...(draft.intents.length > 0 ? { intents: draft.intents } : {}),
  };
}

/** Structural guard for a value read back from storage. */
export function isDraftShape(value: unknown): value is OnboardingDraft {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.children) &&
    Array.isArray(v.intents) &&
    typeof v.location === 'object' &&
    v.location !== null &&
    typeof v.planTier === 'string' &&
    typeof v.tosAccepted === 'boolean'
  );
}
