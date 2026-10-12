import { linqFromE164 } from '~/lib/channel/linq/config';
import { normalizePhoneE164 } from '~/lib/channels/phone';

/**
 * VIL-226 · Linq `phone_number.status_updated`. Flagged or throttled pauses unrequested
 * sends; a healthy status lifts the pause. These are Linq's status words for Hale's own
 * line, not anything a parent typed.
 */

const PAUSED_STATUSES = new Set(['flagged', 'throttled', 'limited', 'suspended']);
/** Linq's words for a line that may send. Anything outside both sets pauses: fail closed. */
const HEALTHY_STATUSES = new Set(['active', 'healthy', 'ok']);

/** A status word: letters and underscores, one short word. Anything else is not stored. */
const STATUS_TOKEN = /^[a-z][a-z_]{0,31}$/i;

export function lineStatusToken(status: string): string | null {
  return STATUS_TOKEN.test(status) ? status : null;
}

/** True when the word is one Hale knows how to read; an unknown word pauses and is named. */
export function lineStatusKnown(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return PAUSED_STATUSES.has(normalized) || HEALTHY_STATUSES.has(normalized);
}

export function lineStatusPauses(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (HEALTHY_STATUSES.has(normalized)) return false;
  return true;
}

/**
 * Hale's sending line (`LINQ_FROM_E164`) in the form a line status is stored in, so a
 * spaced or dashed spelling of the variable still names the same line.
 */
export function sendingLineE164(): string | null {
  const from = linqFromE164();
  return from === null ? null : normalizePhoneE164(from);
}
