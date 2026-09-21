import { namesAPerson } from '~/lib/channel/activity/deidentify';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { SLOTS_IN_TEXT } from '~/lib/channel/activity/share-page';
import { childPhrase } from '~/lib/channel/checkin/copy';
import { withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';

/**
 * THE ONE TEXT A TRIP GETS, and it is DETERMINISTIC.
 *
 * `renderEmailAlert`'s stated reason, and it holds harder here: there is no prompt and no
 * second model call. The picks are already model-produced and already gated — a second
 * composer would only give it a chance to say something the pages did not.
 *
 * WHAT IT MAY NOT DO:
 *   · It carries no LINK. The lane's picks deliberately have no URL ("Hale never texts a
 *     link"), so there is nothing here that could invite one.
 *   · It CLAIMS NOTHING ABOUT ANYONE HAVING BEEN. A web pick has no field in which it
 *     could say it was verified, and the closing sentence says whose facts these are —
 *     which is the lane's own doctrine, not a hedge. A travel find can never be a review
 *     subject either: `activity_reviews.subject_ref` is a Places id or a civic venue id,
 *     and an `ActivityPick` has neither, so there is no k-check to gate and no review
 *     clause to write.
 *   · It ASKS NOTHING. There is no reply handler and no open question behind this text; a
 *     question with nothing behind it is the recorded 2026-08-22 defect.
 *   · It NAMES NO TEEN, and names no age at all. The age adds nothing the picks' own
 *     `ageFit` does not carry and it is one more identifier in a message that may be read
 *     over a shoulder.
 *
 * ENGLISH ONLY, and that is an honest limit rather than an oversight: this class is
 * outbound-first with no inbound message to read a language off, the same reason the
 * evening check-in's ask is English-only. `families.primary_language` is written by
 * nothing.
 *
 * Plain ASCII throughout: one typographic dash flips the whole SMS to UCS-2 and halves the
 * budget. `lib/travel/copy.ts` is registered in SMS_COPY_SOURCES so the scan sees it.
 */

export const TRAVEL_BRIEF_TEMPLATE_KEY = 'travel:brief';

/**
 * FOUR SEGMENTS, measured against the FULL opt-out form — the longest a real send can be,
 * since the form is chosen per recipient and this budget must hold for whichever one the
 * gate picks.
 *
 * Four, not the three the portal legs and the spot-open text sit at, and not the check-in's
 * one. Those carry ONE fact each and one of them arrives nightly; this carries two venue
 * names, two schedules and two prices, and a household gets it at most once per trip —
 * twice a year for the cohort. The discipline that is right for a nightly message is the
 * wrong discipline for this one.
 */
export const MAX_TRAVEL_BRIEF_SEGMENTS = 4;

/** The closing sentence, and it is not decoration: every pick is `source: 'web'`, stamped
 * in code, and this is where the text says so. */
const PROVENANCE = "That's off their own pages, not from anyone who's been.";

export interface TravelBriefInput {
  city: string;
  /** YYYY-MM-DD, the destination's own calendar days. */
  startsOn: string;
  endsOn: string;
  /** The UNDER-13s' first names, read live at send time. Empty is normal and is answered
   * generically — which is the point: a teen's absence from this sentence is
   * indistinguishable from having no children on file. */
  childNames: readonly string[];
  /** Everything the lane found, in its own order. At most {@link SLOTS_IN_TEXT} are
   * rendered; the rest are dropped, not linked. */
  picks: readonly ActivityPick[];
  /** The household's 13+ first names. Passed so the render can REFUSE rather than trim —
   * a teen's name reaching this body is a bug upstream, not a string to fix here. */
  teenNames: readonly string[];
}

export interface TravelBriefContext {
  dayPhrase: string;
  /** The picks that actually made it into the body. */
  rendered: readonly ActivityPick[];
  teenNames: readonly string[];
}

/** "12th", "1st", "22nd", "13th". */
function ordinal(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return `${day}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
  return `${day}${suffix}`;
}

/**
 * "the 12th to the 15th", or "the 12th" for a single day.
 *
 * Day-of-month only, and no month: the text arrives seven days out, so "the 12th" is
 * unambiguous, and the shorter phrase is a whole clause of budget back.
 */
export function tripDayPhrase(startsOn: string, endsOn: string): string {
  const start = ordinal(new Date(`${startsOn}T12:00:00Z`).getUTCDate());
  const end = ordinal(new Date(`${endsOn}T12:00:00Z`).getUTCDate());
  return start === end ? `the ${start}` : `the ${start} to the ${end}`;
}

/** One pick, in the source's own words. A null `when` or `price` omits its clause and
 * invents nothing — the lane's rule that a missing detail is not a dropped find. */
function renderPick(pick: ActivityPick): string {
  const details = [pick.when, pick.price].filter((detail): detail is string => detail !== null);
  return details.length === 0
    ? `${pick.name} (their site).`
    : `${pick.name} - ${details.join(', ')} (their site).`;
}

/** Removes one literal occurrence, so the checks below run on what is left over after the
 * pieces the body is allowed to carry are accounted for. The `spots/copy.ts` helper. */
function without(text: string, literal: string | null): string {
  if (literal === null || literal === '') return text;
  const at = text.indexOf(literal);
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + literal.length)}`;
}

/**
 * Everything wrong with this body, named. Exported because the composer runs it on itself
 * and copy.test.ts runs it on the output: a gate only the composer can reach is a gate
 * nobody can test.
 */
export function travelBriefViolations(body: string, context: TravelBriefContext): string[] {
  const violations: string[] = [];

  if (context.rendered.length === 0) violations.push('no_picks');
  // ON A WORD BOUNDARY, and `namesAPerson` rather than a substring test of its own: that
  // is the boundary the outbound redactor uses, so the set of names this refuses is
  // exactly the set that one replaces. A substring match refuses the WHOLE body, so its
  // false positives are briefs a household never gets -- a teen called Al makes
  // "Algonquin Outfitters" unsendable.
  if (namesAPerson(body, context.teenNames)) violations.push('names_a_teen');

  // Subtract the pieces the body is ALLOWED to carry, then judge what is left. Order
  // matters only in that each subtraction removes the FIRST occurrence.
  let rest = without(body, context.dayPhrase);
  for (const pick of context.rendered) {
    rest = without(rest, pick.name);
    rest = without(rest, pick.when);
    rest = without(rest, pick.price);
  }
  if (rest.includes('?')) violations.push('asks_a_question');
  // A DIGIT WITH NOTHING BEHIND IT. Every number in this text traces to the trip's own
  // dates or to a figure a page published; one that survives the subtraction above was
  // invented by the composer, which on a message carrying prices is the worst thing it
  // could do.
  if (/\d/.test(rest)) violations.push('unbacked_digit');

  if (!isGsm7(body)) violations.push('not_gsm7');
  if (smsSegments(withOptOut(body, 'full')) > MAX_TRAVEL_BRIEF_SEGMENTS) {
    violations.push('too_many_segments');
  }
  return violations;
}

/**
 * The body, or nothing at all.
 *
 * A refusal here is NOT recoverable by trimming: a brief whose numbers cannot be traced to
 * a pick is not a text worth sending in a shorter form. The `renderSpotOpen` shape.
 *
 * The assembly is WHOLE-PICK-AT-A-TIME, never truncated — the `share-page.ts` rule, and it
 * is not tidiness: a cut that lands inside "USD 2" publishes a wrong price. A second pick
 * that would push past the ceiling is dropped entire.
 */
export function renderTravelBrief(input: TravelBriefInput): string {
  const dayPhrase = tripDayPhrase(input.startsOn, input.endsOn);
  const opening = `You're in ${input.city} ${dayPhrase}. A couple of things on for ${childPhrase([...input.childNames])}:`;

  const rendered: ActivityPick[] = [];
  let body = opening;
  for (const pick of input.picks.slice(0, SLOTS_IN_TEXT)) {
    const candidate = `${body} ${renderPick(pick)}`;
    // Measured against the FULL form and WITH the closing sentence already counted, so the
    // provenance line can never be the thing that pushes a sent body over the ceiling.
    if (smsSegments(withOptOut(`${candidate} ${PROVENANCE}`, 'full')) > MAX_TRAVEL_BRIEF_SEGMENTS) {
      break;
    }
    body = candidate;
    rendered.push(pick);
  }
  body = `${body} ${PROVENANCE}`;

  const violations = travelBriefViolations(body, {
    dayPhrase,
    rendered,
    teenNames: input.teenNames,
  });
  if (violations.length > 0) {
    throw new Error(`travel brief copy refused: ${violations.join(', ')}`);
  }
  return body;
}
