import type { ExtractionKind } from './types';

/**
 * A `booking_confirmation` the envelope itself contradicts.
 *
 * The extract skill already tells the model a waitlist is not a held place. That is a
 * prompt. A model that still returns `booking_confirmation` for "you are on the waitlist",
 * "Waitlist Update", "registration opens", or a reminder writes a booking Hale will ask
 * about a week later. This guard is the deterministic refusal after extraction, and it
 * reads only the subject and the snippet — the body is not retained (rule #1).
 */
export type FalseBookingSignal = 'waitlist' | 'registration_opens' | 'reminder_only';

/** A sentence that says this family now holds the place. A waitlist email that also says
 * this has promoted them; refusing it would drop a real receipt. */
const HELD_SPOT =
  /\b(?:you(?:'re| are) registered|you(?:'re| are) enrolled|you(?:'re| are) in\b|enrol?led|spot is confirmed|your (?:spot|place) is confirmed|registration (?:confirmation|confirmed)|payment received)\b/i;

const PROMOTED_OFF_WAITLIST =
  /\b(?:off the wait\s*list|no longer on the wait\s*list|moved off the wait\s*list)\b/i;

const WAITLIST = /\b(?:wait\s*list|waiting list)\b/i;

const REGISTRATION_OPENS =
  /\b(?:registration|sign[- ]?up|enrollment|enrolment) (?:opens|will open|is opening)\b/i;

/** A reminder label, not the word buried in a receipt. "Reminder:" and "this is a
 * reminder" are the mail; "payment receipt" is not. */
const REMINDER =
  /(?:^\s*reminder\b|\bthis is a reminder\b|\bjust a reminder\b|\breminder\s*[:\-])/i;

function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Why this envelope cannot be a held place, or null when it might be one.
 *
 * Reminder wins over a held-spot sentence: "Reminder: you're registered for Saturday"
 * is a reminder of a booking Hale should already hold, not a second one. A promotion
 * off the waitlist ("you're registered", "off the waitlist") is left to the model.
 */
export function falseBookingSignal(input: {
  subject: string;
  snippet: string;
}): FalseBookingSignal | null {
  const subject = fold(input.subject);
  const snippet = fold(input.snippet);
  const text = `${subject}\n${snippet}`;

  if (REMINDER.test(subject) || REMINDER.test(snippet)) return 'reminder_only';

  const held = HELD_SPOT.test(text) || PROMOTED_OFF_WAITLIST.test(text);
  if (!held && WAITLIST.test(text)) return 'waitlist';
  if (!held && REGISTRATION_OPENS.test(text)) return 'registration_opens';
  return null;
}

/**
 * The kind Hale may act on. A false booking becomes `reminder_only` so the alert does
 * not say "you're in" and {@link bookingDraft} (which accepts only
 * `booking_confirmation`) writes no row.
 */
export function guardBookingConfirmation(
  kind: ExtractionKind,
  envelope: { subject: string; snippet: string },
): ExtractionKind {
  if (kind !== 'booking_confirmation') return kind;
  return falseBookingSignal(envelope) === null ? kind : 'reminder_only';
}
