import { createHash } from 'node:crypto';

/**
 * The per-event ICS URL is a bearer link, and a ledger row is kept for a year. The
 * dedupe readers only need to know that the part carrying this event's link went
 * out, so the row stores this hash of the event id and never the signature.
 */
export function inviteLinkHash(familyEventId: string): string {
  return createHash('sha256').update(`ics-link:${familyEventId}`).digest('hex');
}
