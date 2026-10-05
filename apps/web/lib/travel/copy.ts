import { namesAPerson } from '~/lib/channel/activity/deidentify';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { SLOTS_IN_TEXT } from '~/lib/channel/activity/share-page';
import type { TravelPickFact } from '~/lib/channel/nudge/proactive-line';
import { type TravelBriefProseContext, travelBriefProseViolations } from './brief-lint';

export { MAX_TRAVEL_BRIEF_SEGMENTS } from './brief-lint';

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

export interface TravelBriefContext extends TravelBriefProseContext {
  teenNames: readonly string[];
}

/**
 * Everything wrong with this body, named. Exported because the sweep runs it on the
 * spoken body and copy.test.ts runs it on fixtures: a gate only the sweep can reach is a
 * gate nobody can test. The prose checks live in brief-lint.ts (pure, so the worker eval
 * runs them on the model's brief too); this adds the one that needs the redactor.
 */
export function travelBriefViolations(body: string, context: TravelBriefContext): string[] {
  const violations = travelBriefProseViolations(body, context);
  // ON A WORD BOUNDARY, and `namesAPerson` rather than a substring test of its own: that
  // is the boundary the outbound redactor uses, so the set of names this refuses is
  // exactly the set that one replaces. A substring match refuses the WHOLE body, so its
  // false positives are briefs a household never gets -- a teen called Al makes
  // "Algonquin Outfitters" unsendable.
  if (namesAPerson(body, context.teenNames)) violations.push('names_a_teen');
  return violations;
}
