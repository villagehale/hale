import { namesAPerson } from '~/lib/channel/activity/deidentify';
import type { ActivityReference } from '~/lib/channel/activity/facts';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { SLOTS_IN_TEXT } from '~/lib/channel/activity/share-page';
import { childPhrase } from '~/lib/channel/checkin/copy';
import { acceptReplyLanguage } from '~/lib/channel/language';
import { withOptOut } from '~/lib/channel/opt-out';
import { smsSegments } from '~/lib/channel/sms-segments';
import { type SpokenLineRequest, type SpokenLineWriter, speak } from '~/lib/channel/spoken-line';

/**
 * THE ONE TEXT A TRIP GETS. The writer composes it from the facts below. A null
 * write sends nothing.
 *
 * WHAT IT MAY NOT DO:
 *   · It carries no LINK. The lane's picks deliberately have no URL ("Hale never texts a
 *     link"), so there is nothing here that could invite one.
 *   · It CLAIMS NOTHING ABOUT ANYONE HAVING BEEN. A web pick has no field in which it
 *     could say it was verified. The writer is given the source name, not a closing
 *     sentence. A travel find can never be a review
 *     subject either: `activity_reviews.subject_ref` is a Places id or a civic venue id,
 *     and an `ActivityPick` has neither, so there is no k-check to gate and no review
 *     clause to write.
 *   · It ASKS NOTHING. There is no reply handler and no open question behind this text; a
 *     question with nothing behind it is the recorded 2026-08-22 defect.
 *   · It NAMES NO TEEN, and names no age at all. The age adds nothing the picks' own
 *     `ageFit` does not carry and it is one more identifier in a message that may be read
 *     over a shoulder.
 *
 * The writer chooses the language. This file does not.
 *
 * `lib/travel/copy.ts` is registered in SMS_COPY_SOURCES so the scan sees it.
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
  /** Source-bound leads only; their schedules, ages and prices are not rendered. */
  references?: readonly ActivityReference[];
  /** The household's 13+ first names. Passed so the render can REFUSE rather than trim —
   * a teen's name reaching this body is a bug upstream, not a string to fix here. */
  teenNames: readonly string[];
  /** Group versus one parent. A fact for the writer, not a sentence. */
  forGroup?: boolean;
  /** The parent's stored BCP-47 tag. The schedule is written in this language. */
  language?: string | null;
}

export interface TravelBriefContext {
  dayPhrase: string;
  /** The picks that actually made it into the body. */
  rendered: readonly ActivityPick[];
  renderedReferences?: readonly ActivityReference[];
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

  if (context.rendered.length === 0 && !context.renderedReferences?.length) {
    violations.push('no_picks');
  }
  // ON A WORD BOUNDARY, and `namesAPerson` rather than a substring test of its own: that
  // is the boundary the outbound redactor uses, so the set of names this refuses is
  // exactly the set that one replaces. A substring match refuses the WHOLE body, so its
  // false positives are briefs a household never gets -- a teen called Al makes
  // "Algonquin Outfitters" unsendable.
  if (namesAPerson(body, context.teenNames)) violations.push('names_a_teen');

  // Subtract the pieces the body is ALLOWED to carry, then judge what is left. Order
  // matters only in that each subtraction removes the FIRST occurrence.
  const allowedDigits = new Set<string>();
  const allowDigits = (text: string | null | undefined) => {
    for (const raw of text?.match(/\d+/g) ?? []) {
      allowedDigits.add(raw);
      const trimmed = raw.replace(/^0+(?=\d)/, '');
      if (trimmed !== raw) allowedDigits.add(trimmed);
    }
  };
  allowDigits(context.dayPhrase);
  let rest = without(body, context.dayPhrase);
  for (const pick of context.rendered) {
    allowDigits(pick.name);
    allowDigits(pick.when);
    allowDigits(pick.price);
    rest = without(rest, pick.name);
    rest = without(rest, pick.when);
    rest = without(rest, pick.price);
  }
  for (const reference of context.renderedReferences ?? []) {
    allowDigits(reference.name);
    allowDigits(reference.sourceName);
    rest = without(rest, reference.name);
    rest = without(rest, reference.sourceName);
  }
  // A schedule written in the parent's language no longer contains the source's
  // sentence, but its days, times, and dates are the same numerals.
  rest = rest.replace(/\d+/g, (raw) => (allowedDigits.has(raw) ? '' : raw));
  if (rest.includes('?')) violations.push('asks_a_question');
  // A DIGIT WITH NOTHING BEHIND IT. Every number in this text traces to the trip's own
  // dates or to a figure a page published; one that survives the subtraction above was
  // invented by the composer, which on a message carrying prices is the worst thing it
  // could do.
  if (/\d/.test(rest)) violations.push('unbacked_digit');

  if (smsSegments(withOptOut(body, 'full')) > MAX_TRAVEL_BRIEF_SEGMENTS) {
    violations.push('too_many_segments');
  }
  return violations;
}

export interface TravelBriefRender {
  body: string;
  /**
   * THE PICKS THE PARENT WAS ACTUALLY TOLD ABOUT, and the reason this is a return value
   * rather than something the caller recomputes.
   *
   * How many picks are in the body is a decision only the assembly below makes: the lane
   * may hand up three, {@link SLOTS_IN_TEXT} caps it at two, and a draft past the segment
   * ceiling leaves the last fact out and asks the writer once more. The sweep's
   * `travel_brief_sent` audit row counted
   * `found.picks.length` instead — so the receipt a parent reads in the trail said THREE
   * on a text that named two, live, on the very first recorded New York find. A count
   * derived a second time from a different object is a count that can disagree with the
   * message; this one is the assembly's own.
   */
  rendered: readonly ActivityPick[];
  /** Named leads with explicit uncertainty, never supported picks. */
  renderedReferences: readonly ActivityReference[];
}

function pushPiece(pieces: string[], piece: string | null | undefined) {
  if (!piece || pieces.includes(piece)) return;
  pieces.push(piece);
}

/** Name, price, and source stay exact. The schedule is not here: it is rewritten in the parent's language. */
function listingVerbatim(
  picks: readonly ActivityPick[],
  references: readonly ActivityReference[],
): string[] {
  const pieces: string[] = [];
  for (const pick of picks) {
    pushPiece(pieces, pick.name);
    pushPiece(pieces, pick.price);
    pushPiece(pieces, pick.sourceName);
  }
  for (const reference of references) {
    pushPiece(pieces, reference.name);
    pushPiece(pieces, reference.sourceName);
  }
  return pieces;
}

function slotTravelBrief(input: TravelBriefInput): {
  picks: ActivityPick[];
  references: ActivityReference[];
} {
  const picks: ActivityPick[] = [];
  const references: ActivityReference[] = [];
  for (const pick of input.picks.slice(0, SLOTS_IN_TEXT)) picks.push(pick);
  for (const reference of (input.references ?? []).slice(0, SLOTS_IN_TEXT - picks.length)) {
    references.push(reference);
  }
  return { picks, references };
}

function withoutLastFact(
  picks: readonly ActivityPick[],
  references: readonly ActivityReference[],
): { picks: ActivityPick[]; references: ActivityReference[] } {
  if (references.length > 0) return { picks: [...picks], references: references.slice(0, -1) };
  return { picks: picks.slice(0, -1), references: [...references] };
}

function listingFacts(
  input: TravelBriefInput,
  dayPhrase: string,
  kids: string,
  rendered: readonly ActivityPick[],
  renderedReferences: readonly ActivityReference[],
): Record<string, string> {
  return {
    city: input.city,
    days: dayPhrase,
    kids,
    audience: input.forGroup ? 'group' : 'parent',
    picks: JSON.stringify(
      rendered.map((pick) => ({
        name: pick.name,
        when: pick.when,
        price: pick.price,
        source: pick.sourceName,
      })),
    ),
    references: JSON.stringify(
      renderedReferences.map((reference) => ({
        name: reference.name,
        source: reference.sourceName,
        status: reference.status,
      })),
    ),
  };
}

/** The spoken-line request for one slotted set. The eval caches this request unchanged. */
export function travelListingRequest(
  input: TravelBriefInput,
  picks: readonly ActivityPick[],
  references: readonly ActivityReference[],
): SpokenLineRequest {
  const dayPhrase = tripDayPhrase(input.startsOn, input.endsOn);
  const kids = childPhrase([...input.childNames]);
  return {
    purpose: 'travel_source_listings',
    language: acceptReplyLanguage(input.language),
    facts: listingFacts(input, dayPhrase, kids, picks, references),
    verbatim: listingVerbatim(picks, references),
  };
}

/**
 * The first ask, and the one-fewer-fact ask the segment ceiling may make. The retry
 * request is known from the facts; whether it is sent depends on the first draft.
 */
export function travelWriterPlans(input: TravelBriefInput): {
  first: SpokenLineRequest;
  retry: SpokenLineRequest | null;
} {
  const slotted = slotTravelBrief(input);
  if (slotted.picks.length + slotted.references.length === 0) {
    throw new Error('travel brief copy refused: no_picks');
  }
  const first = travelListingRequest(input, slotted.picks, slotted.references);
  if (slotted.picks.length + slotted.references.length < 2) return { first, retry: null };
  const next = withoutLastFact(slotted.picks, slotted.references);
  return { first, retry: travelListingRequest(input, next.picks, next.references) };
}

/**
 * The body, or nothing at all.
 *
 * A refusal here is NOT recoverable by trimming a sentence: a brief whose numbers cannot
 * be traced to a pick is not a text worth sending in a shorter form. The `renderSpotOpen`
 * shape.
 *
 * The writer composes the whole text from the slotted facts. When that text is past the
 * segment ceiling and more than one fact was offered, the last fact is left out and the
 * writer is asked again. A single fact that still does not fit sends nothing. This file
 * does not cut a sentence the model wrote — a cut inside "USD 2" would publish a wrong price.
 */
export async function renderTravelBrief(
  input: TravelBriefInput,
  writer: Pick<SpokenLineWriter, 'write'> = { write: (request) => speak(request) },
): Promise<TravelBriefRender> {
  const dayPhrase = tripDayPhrase(input.startsOn, input.endsOn);
  let { picks: rendered, references: renderedReferences } = slotTravelBrief(input);

  if (rendered.length === 0 && renderedReferences.length === 0) {
    throw new Error('travel brief copy refused: no_picks');
  }

  const ask = async (picks: readonly ActivityPick[], references: readonly ActivityReference[]) => {
    const written = await writer.write(travelListingRequest(input, picks, references));
    if (!written) throw new Error('travel brief copy refused: model_unreachable');
    return written;
  };

  let written = await ask(rendered, renderedReferences);
  let violations = travelBriefViolations(written, {
    dayPhrase,
    rendered,
    renderedReferences,
    teenNames: input.teenNames,
  });
  // The last slotted fact is the one that can be left out. One shorter ask, still the
  // writer's own text. A draft that fails for any other reason is not retried.
  if (
    violations.length === 1 &&
    violations[0] === 'too_many_segments' &&
    rendered.length + renderedReferences.length > 1
  ) {
    const next = withoutLastFact(rendered, renderedReferences);
    rendered = next.picks;
    renderedReferences = next.references;
    written = await ask(rendered, renderedReferences);
    violations = travelBriefViolations(written, {
      dayPhrase,
      rendered,
      renderedReferences,
      teenNames: input.teenNames,
    });
  }
  if (violations.length > 0) {
    throw new Error(`travel brief copy refused: ${violations.join(', ')}`);
  }
  return { body: written, rendered, renderedReferences };
}
