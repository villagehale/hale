import type { PageControl, PageSnapshot, SignupStopReason } from '../types';
import { controlHay } from './hay';
import { rushSignal } from './rush';

const PAYMENT = /card|cc-number|cc-exp|cc-csc|\bcvv\b|\bcvc\b|payment|stripe/;
const WAIVER = /\bwaivers?\b|liability release|release of liability|assumption of risk/;
const MEDICAL = /\bmedical\b|\bmedication\b|\bphysician\b|health condition|immuniz/;
const ALLERGY = /\ballerg|\banaphylax|\bepipen\b|\bepi-pen\b/;

/** Stops that apply before any adapter types a field. */
export function pageStops(
  snapshot: PageSnapshot,
  expectedOrigin: string,
  approvedPriceCents: number | null,
): SignupStopReason | null {
  let origin: string;
  try {
    origin = new URL(snapshot.href).origin;
  } catch {
    return 'redirect';
  }
  if (origin !== expectedOrigin) return 'redirect';
  if (snapshot.captcha) return 'captcha';
  if (snapshot.waitingRoom) return 'waiting_room';
  if (snapshot.residentVerification) return 'resident_verification';
  if (snapshot.timedOpen) return 'timed_open';
  const hay = [snapshot.formText, ...snapshot.controls.map((control) => controlHay(control))]
    .join(' ')
    .toLowerCase();
  const rush = rushSignal(hay);
  if (rush) return rush;
  if (WAIVER.test(hay)) return 'waiver';
  if (MEDICAL.test(hay)) return 'medical';
  if (ALLERGY.test(hay)) return 'allergy';
  return pricesApproved(snapshot.priceCents, approvedPriceCents);
}

export function classifySafetyField(control: PageControl): 'payment' | 'login' | null {
  const hay = controlHay(control);
  if (PAYMENT.test(hay) || (control.autocomplete ?? '').toLowerCase().startsWith('cc-')) {
    return 'payment';
  }
  const autocomplete = (control.autocomplete ?? '').toLowerCase();
  if (
    control.type === 'password' ||
    autocomplete === 'one-time-code' ||
    /\bpassword\b|\b(2fa|otp|mfa|totp)\b|two factor|authenticator|verification code|one time code/.test(
      hay,
    )
  ) {
    return 'login';
  }
  return null;
}

/** A waitlist is a full session. Hale does not join one. */
export function waitlistControl(control: PageControl): boolean {
  return /\bwaitlist\b/i.test(controlHay(control));
}

export function noteStops(note: string): SignupStopReason | null {
  if (ALLERGY.test(note)) return 'allergy';
  if (MEDICAL.test(note)) return 'medical';
  if (WAIVER.test(note)) return 'waiver';
  return null;
}

function pricesApproved(
  found: readonly number[],
  approved: number | null,
): SignupStopReason | null {
  const charged = found.filter((cents) => cents > 0);
  if (charged.length === 0) return null;
  if (charged.length !== 1 || approved === null) return 'price_not_approved';
  if (approved !== charged[0]) return 'price_change';
  return null;
}
