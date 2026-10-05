import { withOptOut } from '../channel/opt-out';
import { isGsm7, smsSegments } from '../channel/sms-segments';

/**
 * The pure half of the travel-brief lint: everything `travelBriefViolations`
 * (lib/travel/copy.ts) checks that needs no family data. Relative imports only, so the
 * worker eval (apps/worker/evals/run-proactive-voice-eval.mjs) loads it through tsx and
 * holds the model's brief to the same bar the sweep does. The teen-name check stays in
 * copy.ts: it rides the outbound redactor, which is not a pure module.
 */

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

export interface TravelBriefProseContext {
  dayPhrase: string;
  /** The picks that actually made it into the body. */
  rendered: readonly { name: string; when: string | null; price: string | null }[];
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
 * Everything wrong with the prose of a brief, named: no picks named, a question, a digit
 * that traces to no fact, no provenance sentence, a non-GSM-7 character, or too many
 * segments. The sweep adds the teen-name check on top (copy.ts).
 */
export function travelBriefProseViolations(
  body: string,
  context: TravelBriefProseContext,
): string[] {
  const violations: string[] = [];

  if (context.rendered.length === 0) violations.push('no_picks');

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
