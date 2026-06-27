/**
 * The light, NON-SENSITIVE intake the wizard gathers before sign-in (Phase A) plus
 * the plan + ToS choice from Phase B, parked in sessionStorage so they survive the
 * Google OAuth redirect (Phase C reads them back, signed in). No full date of birth
 * and no health data ever lives here — dates of birth are collected only post-auth
 * (rule #1). A coarse city is non-sensitive and carries through; the full structured
 * location (province, postal code) is collected post-auth in Phase C.
 *
 * sessionStorage (not localStorage): the draft is scoped to the tab and cleared on
 * completion, so a shared device doesn't leak one family's intake into the next.
 */

const KEY = 'hale_intake';

export interface IntakeDraft {
  /** Each child's first name. Phase A asks for names only — no dates of birth. */
  childNames: string[];
  /** Coarse city (non-sensitive) for early local-discovery framing. */
  city: string;
  /** Chosen onboarding intents (OnboardingIntent values) — optional, may be empty. */
  intents: string[];
  planTier: string;
  tosAccepted: boolean;
  /**
   * A coarse FamilyStage chosen on the pre-auth preview (an age RANGE, never a
   * DOB). Optional and non-sensitive: it survives the sign-in round-trip so
   * onboarding can hint the child's stage, but the actual date of birth is still
   * entered and consented post-auth in Phase C (rule #1). Absent when the visitor
   * entered onboarding directly without the preview.
   */
  stage?: string;
}

export function readIntakeDraft(): IntakeDraft | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = window.sessionStorage.getItem(KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as IntakeDraft;
  } catch {
    return null;
  }
}

export function writeIntakeDraft(draft: IntakeDraft): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.sessionStorage.setItem(KEY, JSON.stringify(draft));
}

export function clearIntakeDraft(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.sessionStorage.removeItem(KEY);
}
