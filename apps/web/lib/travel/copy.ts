import { namesAPerson } from '~/lib/channel/activity/deidentify';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { SLOTS_IN_TEXT } from '~/lib/channel/activity/share-page';
import type { TravelPickFact } from '~/lib/channel/nudge/proactive-line';
import { withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';

/**
 * THE ONE TEXT A TRIP GETS — the facts it is built from and the lint it must pass.
 *
 * THE WHOLE BODY IS THE MODEL'S (VIL-413 / VIL-417, founder rule 2026-10-04). The sweep
 * speaks it through the proactive-voice skill (`travel_brief`, nudge/proactive-line.ts)
 * from the city, the trip's day phrase, the under-13s' names and up to two picks — each
 * pick's name, schedule and price exactly as the venue published them — and says in its
 * own words that those details are off the venues' own pages. Until this change the
 * opening was spoken and the picks and the closing provenance sentence were two fixed
 * templates (`renderPick`, `PROVENANCE`); they are gone. The model is handed the venues'
 * words and must carry them; nothing here writes a sentence.
 *
 * WHAT THE LINT HOLDS, after the engine's own judge:
 *   · It carries no LINK. The lane's picks deliberately have no URL ("Hale never texts a
 *     link"), so there is nothing here that could invite one; the judge refuses any.
 *   · It CLAIMS NOTHING ABOUT ANYONE HAVING BEEN. A web pick has no field in which it
 *     could say it was verified, and the body must say whose facts these are
 *     (`no_provenance`) — which is the lane's own doctrine, not a hedge. A travel find can
 *     never be a review subject either: `activity_reviews.subject_ref` is a Places id or
 *     a civic venue id, and an `ActivityPick` has neither.
 *   · It ASKS NOTHING. There is no reply handler and no open question behind this text; a
 *     question with nothing behind it is the recorded 2026-08-22 defect.
 *   · It NAMES NO TEEN, and invents no digit: every number traces to the trip's own
 *     dates or to a figure a page published.
 *
 * ENGLISH ONLY, and that is an honest limit rather than an oversight: this class is
 * outbound-first with no inbound message to read a language off, the same reason the
 * evening check-in's ask is English-only. `families.primary_language` is written by
 * nothing.
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

/**
 * The picks the model is handed: at most {@link SLOTS_IN_TEXT}, in the lane's own order,
 * each reduced to the three things a parent can act on. The rest are dropped, not linked.
 * A null `when` or `price` stays null — the lane's rule that a missing detail is not a
 * dropped find, and the skill's rule that null is not filled.
 */
export function travelBriefPicks(picks: readonly ActivityPick[]): TravelPickFact[] {
  return picks
    .slice(0, SLOTS_IN_TEXT)
    .map((pick) => ({ name: pick.name, when: pick.when, price: pick.price }));
}

/** The picks a body actually names, which is what the parent was told about. */
export function picksNamedIn<T extends { name: string }>(body: string, picks: readonly T[]): T[] {
  return picks.filter((pick) => body.includes(pick.name));
}

export interface TravelBriefContext {
  dayPhrase: string;
  /** The picks that actually made it into the body. */
  rendered: readonly { name: string; when: string | null; price: string | null }[];
  teenNames: readonly string[];
}

/** Removes one literal occurrence, so the checks below run on what is left over after the
 * pieces the body is allowed to carry are accounted for. The `spots/copy.ts` helper. */
function without(text: string, literal: string | null): string {
  if (literal === null || literal === '') return text;
  const at = text.indexOf(literal);
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + literal.length)}`;
}

/**
 * The disclosure every brief must make, in the model's own words: these details are off
 * the venues' own pages. Any phrasing that ties "their / own / the venues'" to a page,
 * site or listing counts; what is refused is a body that never says where the facts came
 * from.
 */
const SAYS_PROVENANCE =
  /\b(?:their|its|own|venues?['’]?s?)\b[^.!?]{0,40}\b(?:pages?|sites?|websites?|listings?)\b|\b(?:pages?|sites?|websites?|listings?)\b[^.!?]{0,20}\b(?:their|its|own|venues?)\b/i;

/**
 * Everything wrong with this body, named. Exported because the sweep runs it on the
 * spoken body and copy.test.ts runs it on fixtures: a gate only the sweep can reach is a
 * gate nobody can test.
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
  // invented by the model, which on a message carrying prices is the worst thing it
  // could do.
  if (/\d/.test(rest)) violations.push('unbacked_digit');
  if (!SAYS_PROVENANCE.test(rest)) violations.push('no_provenance');

  if (!isGsm7(body)) violations.push('not_gsm7');
  if (smsSegments(withOptOut(body, 'full')) > MAX_TRAVEL_BRIEF_SEGMENTS) {
    violations.push('too_many_segments');
  }
  return violations;
}
