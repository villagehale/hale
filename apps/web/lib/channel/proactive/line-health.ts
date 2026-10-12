/**
 * VIL-226 · Linq `phone_number.status_updated`. Flagged or throttled pauses unrequested
 * sends; a healthy status lifts the pause. These are Linq's status words for Hale's own
 * line, not anything a parent typed.
 */

const PAUSED_STATUSES = new Set(['flagged', 'throttled', 'limited', 'suspended']);

/** A status word: letters and underscores, one short word. Anything else is not stored. */
const STATUS_TOKEN = /^[a-z][a-z_]{0,31}$/i;

export function lineStatusToken(status: string): string | null {
  return STATUS_TOKEN.test(status) ? status : null;
}

export function lineStatusPauses(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (PAUSED_STATUSES.has(normalized)) return true;
  return normalized.includes('flag') || normalized.includes('throttl');
}
