import type {
  FieldSlot,
  PageControl,
  PageSnapshot,
  SignupIdentity,
  SignupStopReason,
} from './types';

export interface FillInstruction {
  name: string;
  slot: FieldSlot;
  value: string;
  control: 'fill' | 'select';
}

export type Inspection =
  | { action: 'submit'; fills: FillInstruction[]; sessionControl: string }
  | { action: 'stop'; reason: SignupStopReason; prefilled: string[] };

const PAYMENT = /card|cc-number|cc-exp|cc-csc|\bcvv\b|\bcvc\b|payment|stripe/;
const WAIVER = /\bwaivers?\b|liability release|release of liability|assumption of risk/;
const MEDICAL = /\bmedical\b|\bmedication\b|\bphysician\b|health condition|immuniz/;
const ALLERGY = /\ballerg|\banaphylax|\bepipen\b|\bepi-pen\b/;

/**
 * Decide whether this page can be completed safely.
 *
 * Inspect before any fill. Payment, captcha, a login wall or a second factor, a waiver, a medical
 * or allergy form, a waiting room, a price the parent has not approved, a full
 * or missing session, or a required field Hale does not know how to fill are
 * stops. Only required known fields are filled.
 */
export function inspectRegistrationPage(input: {
  snapshot: PageSnapshot;
  identity: SignupIdentity;
  sessionId: string;
  approvedPriceCents: number | null;
  expectedOrigin: string;
}): Inspection {
  let origin: string;
  try {
    origin = new URL(input.snapshot.href).origin;
  } catch {
    return stop('redirect');
  }
  if (origin !== input.expectedOrigin) return stop('redirect');
  if (input.snapshot.captcha) return stop('captcha');
  const sensitive = sensitiveForm(input.snapshot);
  if (sensitive) return stop(sensitive);
  const priced = pricesApproved(input.snapshot.priceCents, input.approvedPriceCents);
  if (priced !== true) return stop(priced);

  const controls = input.snapshot.controls.filter((control) => !ignored(control));
  if (controls.some((control) => control.type === 'password' || slotKind(control) === 'login')) {
    return stop('login_wall');
  }
  if (controls.some((control) => slotKind(control) === 'payment')) return stop('payment');

  const sessionControls = controls.filter((control) => slotKind(control) === 'session');
  if (sessionControls.length !== 1) return stop('unexpected_field');
  const sessionControl = sessionControls[0];
  if (!sessionControl) return stop('unexpected_field');
  const option = sessionControl.options.find((item) => item.value === input.sessionId);
  if (!option) return stop('session_not_offered');
  if (option.disabled || /\b(full|waitlist|sold out)\b/i.test(option.label)) {
    return stop('session_full');
  }

  const fills: FillInstruction[] = [
    {
      name: sessionControl.name,
      slot: 'session',
      value: input.sessionId,
      control: 'select',
    },
  ];
  for (const control of controls) {
    if (control === sessionControl) continue;
    const kind = slotKind(control);
    if (kind === 'unknown') {
      if (control.required) return stop('unexpected_field');
      continue;
    }
    if (kind === 'session' || kind === 'payment' || kind === 'login') continue;
    if (!control.required) continue;
    const value = valueFor(kind, input.identity);
    if (!value) return stop('missing_detail');
    fills.push({
      name: control.name,
      slot: kind,
      value,
      control: control.type === 'select' ? 'select' : 'fill',
    });
  }
  return { action: 'submit', fills, sessionControl: sessionControl.name };
}

function stop(reason: SignupStopReason): Inspection {
  return { action: 'stop', reason, prefilled: [] };
}

function sensitiveForm(snapshot: PageSnapshot): SignupStopReason | null {
  if (snapshot.waitingRoom) return 'waiting_room';
  const hay = [snapshot.formText, ...snapshot.controls.map((control) => controlHay(control))]
    .join(' ')
    .toLowerCase();
  if (WAIVER.test(hay)) return 'waiver';
  if (MEDICAL.test(hay)) return 'medical';
  if (ALLERGY.test(hay)) return 'allergy';
  return null;
}

function controlHay(control: PageControl): string {
  return `${control.name} ${control.label} ${control.autocomplete ?? ''}`;
}

function pricesApproved(
  found: readonly number[],
  approved: number | null,
): true | 'price_not_approved' | 'price_change' {
  const charged = found.filter((cents) => cents > 0);
  if (charged.length === 0) return true;
  if (charged.length !== 1 || approved === null) return 'price_not_approved';
  if (approved !== charged[0]) return 'price_change';
  return true;
}

function ignored(control: PageControl): boolean {
  return control.type === 'hidden' || control.type === 'submit' || control.type === 'button';
}

function slotKind(control: PageControl): FieldSlot | 'payment' | 'login' | 'unknown' {
  const hay = `${controlHay(control)} ${control.type}`.toLowerCase().replace(/[_-]+/g, ' ');
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
  if (/child (first|given)|participant first|camper first|kid first|child name/.test(hay)) {
    return 'child_first_name';
  }
  if (/child (last|family|surname)|participant last/.test(hay)) return 'child_last_name';
  if (/\bdob\b|date of birth|birth date|birthdate/.test(hay)) return 'child_dob';
  if (/\bemail\b/.test(hay)) return 'parent_email';
  if (/postal|postcode|\bzip\b/.test(hay)) return 'postal_code';
  if (
    /session|time slot|timeslot|class time|showtime|show time|reservation time|seating time|booking time/.test(
      hay,
    )
  ) {
    return 'session';
  }
  if (
    /parent (first|given)|guardian first|guardian name|your name|contact name|guest name|visitor name|reservation name|ticket holder|booker name/.test(
      hay,
    )
  ) {
    return 'parent_first_name';
  }
  return 'unknown';
}

function valueFor(slot: FieldSlot, identity: SignupIdentity): string | null {
  switch (slot) {
    case 'child_first_name':
      return blank(identity.childFirstName);
    case 'child_last_name':
      return blank(identity.childLastName);
    case 'child_dob':
      return blank(identity.childDob);
    case 'parent_first_name':
      return blank(identity.parentFirstName);
    case 'parent_email':
      return blank(identity.parentEmail);
    case 'postal_code':
      return blank(identity.postalCode);
    case 'session':
      return null;
  }
}

function blank(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
