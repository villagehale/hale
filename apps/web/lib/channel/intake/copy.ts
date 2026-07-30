import { appBaseUrl } from '~/lib/cron/email-compliance';

/**
 * VIL-237 · M2 — every word Hale texts during intake, in one file.
 *
 * This is the SPEC, not a template layer: the eval suites and the state-machine
 * tests assert against these exact strings, so a copy change is a deliberate,
 * reviewable diff rather than a silent drift in what a stranger's first contact with
 * Hale sounds like. Nothing here is model-composed — intake copy is deterministic by
 * construction (the model reads the parent's words; it never writes Hale's).
 *
 * Rule #1: no message ever carries a child's health detail, a precise location, or
 * anything the parent did not just tell us in this conversation.
 */

export interface SourceVenue {
  /** How the venue is named back to the parent. */
  name: string;
  /** The venue's OWN coarse area (FSA). This is a fact about where the poster hangs,
   * not a claim about where the family lives — it seeds discovery when the parent was
   * never asked for a postal code (rule #1: coarse only, never an address). */
  areaCoarse: string;
}

/**
 * The QR venue codes a prefilled body may carry. The registry IS the source of truth:
 * an unrecognised code is treated as no context at all rather than echoed, so Hale can
 * never claim to know a place we have never heard of, nor infer an area from one.
 */
export const SOURCE_VENUES: Record<string, SourceVenue> = {
  LIBRARY: { name: 'library', areaCoarse: 'M5V' },
  REC: { name: 'rec centre', areaCoarse: 'M6K' },
  CLINIC: { name: 'clinic', areaCoarse: 'M4K' },
  SCHOOL: { name: 'school', areaCoarse: 'L7G' },
  'earlyon-richmondhill': { name: 'EarlyON centre', areaCoarse: 'L4C' },
};

/**
 * The prefilled-body conventions. Two forms, both venue-in-the-message (one number,
 * many posters — the venue rides IN the first text rather than in a per-venue phone
 * number or a link the parent would have to open):
 *   1. `HALE <CODE>` — the whole body is the tag (original QR cards).
 *   2. `Hi (via <code>)` — the /text entry page's convention (VIL-240): a human first
 *      message with the tag as a trailing, visibly-disclosed suffix. Suffix-anchored so
 *      an ordinary sentence containing "(via …)" mid-message never matches.
 */
const SOURCE_TAG = /^hale[\s:-]+([a-z0-9-]{2,48})$/i;
const SOURCE_TAG_SUFFIX = /\(via\s+([a-z0-9]+(?:-[a-z0-9]+)*)\)$/i;

/** The canonical registry key for a raw tag, matched case-insensitively. */
function resolveCode(raw: string): string | null {
  if (raw in SOURCE_VENUES) return raw;
  const upper = raw.toUpperCase();
  if (upper in SOURCE_VENUES) return upper;
  const lower = raw.toLowerCase();
  if (lower in SOURCE_VENUES) return lower;
  return null;
}

/** The venue CODE (registry key) for a prefilled first body, or null when the body
 * carries no tag or a tag we don't recognise. */
export function sourceCodeFromBody(body: string): string | null {
  const trimmed = body.trim();
  const full = SOURCE_TAG.exec(trimmed);
  if (full) return resolveCode(full[1] as string);
  const suffix = SOURCE_TAG_SUFFIX.exec(trimmed);
  if (suffix) return resolveCode(suffix[1] as string);
  return null;
}

/** The registry entry for a stored source code, or null. */
export function venueForCode(code: string | null): SourceVenue | null {
  if (!code) return null;
  return SOURCE_VENUES[code] ?? null;
}

export function greeting(venue: string | null): string {
  if (venue) {
    return `Hi, I'm Hale — I keep family weeks on track around here. You found me at the ${venue}, so I know the area. What are your kids' names and ages?`;
  }
  return "Hi, I'm Hale — I keep family weeks on track for GTA parents. What are your kids' names and ages — and what's your postal code?";
}

/**
 * The one-time disclosure. Rides on the FIRST reply only — a stranger deserves to
 * know within one message that they are texting software and where the privacy terms
 * are, and repeating it every turn would be noise, not honesty.
 */
export function assistantDisclosure(): string {
  return `(I'm an assistant, not a person — details & privacy: ${appBaseUrl()}/terms)`;
}

/** The single targeted follow-up, asked at most once per intake. */
export function followUp(summary: string): string {
  return `Got it — ${summary}. What's your postal code?`;
}

export const WATCH_OFFER = 'Want me to keep an eye on all of this for you?';
export const ASSENT_ACK = "Done — you're covered. I'll only text when something actually matters.";
export const DECLINE_ACK = 'No problem — text me whenever you like.';
export const AMBIGUOUS_CLARIFY =
  "Happy either way — should I watch the registration dates at least? That one's easy to miss.";

/**
 * The CASL keyword replies. STOP gets one final confirmation and then silence; HELP
 * (and anything unparseable) gets the same honest capability line, because a parent
 * who typed something we couldn't read needs to know what we CAN do, not an error.
 */
export const STOP_ACK =
  "You're unsubscribed — I won't text you again. Reply START if you ever want me back.";
export const HELP_REPLY =
  "I'm Hale — I keep track of your family's week and text you when something needs doing. Tell me your kids' names and ages and I'll take it from there. Reply STOP to unsubscribe.";
export const START_ACK = "You're back — I'll text you when something needs doing.";

/**
 * Said ONCE when the one follow-up went unanswered and there is still no way to know
 * where the family is. Hale cannot set them up without it (the region gate is a
 * compliance boundary, rule #1), so it states the blocker plainly and then goes quiet
 * rather than asking a third time.
 */
export const AREA_BLOCKED_REPLY =
  "I can't set your family up until I know your postal code — send it whenever you're ready.";

/** The honest close when a postal code is outside the region Hale is cleared for
 * (rule #1). Nothing is provisioned; the reply says so rather than leaving a family
 * believing they are signed up. */
export const REGION_UNAVAILABLE_REPLY =
  "I'm only set up for families in Canada right now, so I can't help yet — I haven't set anything up.";
