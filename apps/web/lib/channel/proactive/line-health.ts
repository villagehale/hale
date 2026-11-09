import { linqFromE164 } from '~/lib/channel/linq/config';
import { normalizePhoneE164 } from '~/lib/channels/phone';

/**
 * VIL-226 · Linq `phone_number.status_updated`. These are Linq's words for Hale's own
 * line, not anything a parent typed. VIL-611 · Linq sends two fields
 * (https://docs.linqapp.com/channel/imessage/guides/phone-numbers/phone-reputation):
 * `new_status` (ACTIVE | FLAGGED) and `new_reputation` (HEALTHY | AT_RISK | CRITICAL).
 * Linq says CRITICAL means pause outbound on the line; FLAGGED means the carrier flagged
 * it. Either pauses unrequested sends. AT_RISK asks for a slower pace, not a pause, so it
 * does not hold them. A word Hale does not know pauses: fail closed.
 */

const SENDABLE_STATUSES = new Set(['active']);
const PAUSED_STATUSES = new Set(['flagged']);
const SENDABLE_REPUTATIONS = new Set(['healthy', 'at_risk']);
const PAUSED_REPUTATIONS = new Set(['critical']);

export interface LineHealth {
  status: string;
  reputation: string;
}

/** A status word: letters and underscores, one short word. Anything else is not stored. */
const STATUS_TOKEN = /^[a-z][a-z_]{0,31}$/i;

export function lineStatusToken(status: string): string | null {
  return STATUS_TOKEN.test(status) ? status : null;
}

function word(value: string): string {
  return value.trim().toLowerCase();
}

/** True when both words are ones Hale knows how to read; an unknown word pauses and is named. */
export function lineHealthKnown(line: LineHealth): boolean {
  const status = word(line.status);
  const reputation = word(line.reputation);
  return (
    (SENDABLE_STATUSES.has(status) || PAUSED_STATUSES.has(status)) &&
    (SENDABLE_REPUTATIONS.has(reputation) || PAUSED_REPUTATIONS.has(reputation))
  );
}

export function lineHealthPauses(line: LineHealth): boolean {
  return !(
    SENDABLE_STATUSES.has(word(line.status)) && SENDABLE_REPUTATIONS.has(word(line.reputation))
  );
}

/** The one word stored in `linq_line_health.status` and named on the #ops page. */
export function lineHealthLabel(line: LineHealth): string {
  return `${line.status}/${line.reputation}`;
}

/**
 * Hale's sending line (`LINQ_FROM_E164`) in the form a line status is stored in, so a
 * spaced or dashed spelling of the variable still names the same line.
 */
export function sendingLineE164(): string | null {
  const from = linqFromE164();
  return from === null ? null : normalizePhoneE164(from);
}
