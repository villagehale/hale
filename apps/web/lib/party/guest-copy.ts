/**
 * VIL-245 · M10 — every word a party GUEST ever sees, in one place, with ZERO imports.
 *
 * Split from the host-facing copy for two reasons, and both are load-bearing:
 *
 *   IT RUNS IN A BROWSER. The RSVP confirmation is a client component, and the
 *     host-side copy reaches `appBaseUrl` → `email-compliance` → `@hale/db`. A server
 *     module in a public bundle is a build error today and a leak surface tomorrow.
 *   IT IS THE CASL SURFACE. These are the strings shown to, and texted to, people who
 *     are not customers. Keeping them in one dependency-free file means the whole set
 *     can be read at once and reviewed as one promise.
 *
 * Nothing here is model-composed. Neither text ends with an opt-out line (founder
 * decision, 2026-10-01). A guest who texts STOP is still opted out on the inbound path.
 */

/**
 * The day-before reminder — the ONLY unprompted message a guest ever receives, and only
 * because they ticked a box asking for it. It says who it is from, what it is about,
 * and why they are getting it, in that order.
 */
export function guestReminder(title: string, when: string, location: string | null): string {
  const where = location === null ? '' : ` at ${location}`;
  return `Reminder from Hale: ${title} is tomorrow - ${when}${where}. You asked me to remind you.`;
}

/** Sent when a host cancels. A guest who asked to be reminded about a party has asked,
 * by any reasonable reading, to be told when it is off. */
export function guestCancellation(title: string): string {
  return `From Hale: ${title} has been cancelled by the host. Sorry for the change.`;
}

/**
 * THE ONE SOFT LINE. It appears on the RSVP CONFIRMATION screen and nowhere else —
 * not on the invite before they answer, not in the reminder, not in any email, and
 * never in a message Hale sends them. A guest gave a name and a yes for a child's
 * birthday; that is not a lead, and one sentence on a page they chose to visit is the
 * entire marketing budget this feature is allowed.
 */
export const GUEST_SOFT_LINE = 'Hale made this invite for the host.';
export const GUEST_SOFT_CTA = 'See what it does for your family';
