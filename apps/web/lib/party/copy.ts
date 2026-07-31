import { appBaseUrl } from '~/lib/cron/email-compliance';
import { GUEST_OF_HONOUR } from './card';

export * from './guest-copy';

/**
 * VIL-245 · M10 — every word Hale says to the HOST about a party.
 *
 * The guest-facing half lives in ./guest-copy (re-exported here, so this file is still
 * the one place to read the whole vocabulary): it renders in a browser and must stay
 * free of server imports, and it is the CASL surface, which is worth reading as one
 * uninterrupted promise.
 *
 * This is the SPEC, not a template layer: the tests assert against these exact strings.
 * Nothing here is model-composed. The model READS what a parent wrote; it never writes
 * what Hale says — and on this feature that matters twice over, because one of these
 * lines is the only thing Hale ever says to fifteen households who are not customers.
 */

/** The public RSVP page's path. One constant so the SMS, the page and the tests agree. */
export const RSVP_PATH = '/rsvp';

/** The absolute link a host shares. App origin (app.villagehale.com) — never the
 * marketing domain, which 308-redirects and would break a pasted link. */
export function rsvpUrl(publicToken: string): string {
  return `${appBaseUrl()}${RSVP_PATH}/${publicToken}`;
}

// ── to the host ──────────────────────────────────────────────────────────────

/**
 * The offer, made AFTER the occasion is recorded and BEFORE anything is published.
 * It restates every field Hale read back, because the parent is about to authorise a
 * page strangers will read and they must be able to see the mistake before it is one.
 */
export function partyRecorded(when: string, title: string, location: string | null): string {
  const where = location === null ? '' : ` at ${location}`;
  return `Got it — ${title}, ${when}${where}. Want a link guests can RSVP to? Reply YES and I'll make one.`;
}

/**
 * The ONE clarifying question, asked when Hale could not resolve a date it would be
 * publishing. Frozen copy, and there is exactly one of it: this is a REPLY to a message
 * the parent just sent, so a second ask could only happen if they wrote again — which
 * is a new question, not a nag.
 */
export const PARTY_DATE_CLARIFY =
  "I've got the party but not the day — what date and time? Send it however you like.";

/** The link itself. Short, because it is going to be forwarded. */
export function partyLinkReady(url: string): string {
  return `Here's your invite — share this with guests: ${url}\nText me "who's coming?" any time for the headcount.`;
}

/**
 * Said alongside the link when the party is a 13+ child's. The host typed their teen's
 * name and Hale is about to not use it; saying so is the difference between a privacy
 * rule and a surprise.
 */
export function partyTeenNotice(): string {
  return `Because they're 13+, the public page says "${GUEST_OF_HONOUR}" instead of their name.`;
}

export const PARTY_CANCELLED_ACK =
  "Cancelled. The invite page now says so, and I've let the guests who asked for a reminder know.";
