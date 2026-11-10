import { createHash } from 'node:crypto';

/**
 * VIL-588 · store a hash of the tap-to-add link on the ledger, not the signed ICS URL.
 *
 * The per-event URL is a bearer token. `recordBody: true` used to keep the whole sent
 * text in `channel_messages.body` for a year so the dedupe readers could see whether
 * the part that carries the link landed. They only need a hash of the event id — the
 * signature never has to be stored. Off unless this is exactly `true` (no trim): a
 * piped `echo` leaves the current body-on-the-ledger behaviour in place.
 */

export const CALENDAR_INVITE_LINK_HASH_ENABLED_ENV = 'CALENDAR_INVITE_LINK_HASH_ENABLED';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EVENT_ID_IN_INVITE_URL = new RegExp(`/api/ics/event/(${UUID_RE})\\.`, 'i');

export function calendarInviteLinkHashEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CALENDAR_INVITE_LINK_HASH_ENABLED_ENV] === 'true';
}

/** sha256 hex of `ics-link:<familyEventId>`. Both dedupe readers compute this. */
export function inviteLinkHash(familyEventId: string): string {
  return createHash('sha256').update(`ics-link:${familyEventId}`).digest('hex');
}

/** The event id inside a per-event ICS URL, or null when the path is not that shape. */
export function familyEventIdFromInviteUrl(url: string): string | null {
  const match = url.match(EVENT_ID_IN_INVITE_URL);
  return match?.[1] ?? null;
}
