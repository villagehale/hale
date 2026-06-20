/**
 * The light, NON-SENSITIVE intake the wizard gathers before sign-in (Phase A) plus
 * the plan + ToS choice from Phase B, parked in sessionStorage so they survive the
 * Google OAuth redirect (Phase C reads them back, signed in). No full date of birth
 * and no health data ever lives here — that is collected only post-auth (rule #1).
 *
 * sessionStorage (not localStorage): the draft is scoped to the tab and cleared on
 * completion, so a shared device doesn't leak one family's intake into the next.
 */

const KEY = 'hale_intake';

export interface IntakeDraft {
  childName: string;
  /** Approximate age as `YYYY-MM` from <input type="month"> — a month, never a day. */
  approxMonth: string;
  goal: string;
  planTier: string;
  tosAccepted: boolean;
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
