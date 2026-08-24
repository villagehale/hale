import { plainText } from '~/lib/channel/coach/reply';
import type { DeepSlot } from './deep';
import type { SynthesisRow } from './synthesis';

/**
 * THE REFUTATION — the pass that tries to break every row before a parent reads one.
 *
 * WHERE IT SITS: between the synthesis and the composer, and it is the last thing that
 * can tell the difference between a fact and a sentence about a fact. Downstream of here
 * a slot is just text in a projection (followup-note.ts) and the composer's own gates ask
 * only whether the MESSAGE is honest about what Hale did — never whether the FACTS are
 * on the page they claim.
 *
 * WHAT IT REFUSES, and why each one is a real way a parent is hurt:
 *
 *   UNCITED PAGE — the row points at a URL no leg ever opened. That is the whole of the
 *   #529 citation defect: the deep pass exists to be able to say "their page says", and a
 *   row whose page nobody opened is a search snippet wearing a citation.
 *
 *   QUOTE ABSENT — the fact's span is not on the page the fact names. This is the defect a
 *   three-angle merge makes newly easy and a single leg could barely produce: the $86.22
 *   really is printed, on the MUNICIPAL page, for a different programme — and attached to
 *   the gym's row it is a parent turning up with the wrong money.
 *
 *   SOURCE NOT READ — the fact names a page no leg opened. Same defect as an uncited row,
 *   one level down, and it is the hole a per-fact citation would otherwise open.
 *
 *   NO QUOTE / QUOTE TOO SHORT — an assertion with nothing behind it, and an assertion
 *   with something too small to be behind it. "$" appears on every fee page ever written.
 *
 *   NO BACKED FACT — a row whose day, price and registration were all refused. The inline
 *   turn already gave this parent a name and an age band; a second message that adds
 *   nothing dated is the deep lane charging three research legs to repeat itself.
 *
 * IT IS DETERMINISTIC, AND THAT IS THE POINT. An adversary that is itself a model can be
 * argued with — the same prompt that produced the fabricated row produces the defence of
 * it. This one cannot be argued with: the quote is either in the bytes the synthesis was
 * handed or it is not. The medical lane reached the same conclusion for the same reason
 * (runtime fail-closed invariants, not a second opinion).
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. No pages read means every row is refused, which is
 * correct: with nothing opened there is no evidence for anything, and the promise stays
 * open for a leg that can actually look.
 *
 * IT REFUSES, IT NEVER REWRITES. A refused fact becomes `null` — the same absence the
 * page never publishing it would produce — and the composer already knows how to say
 * "their site did not carry the price". A refused row is dropped whole. Nothing here
 * paraphrases a fact into something safer, because a fact Hale is unsure of is a fact
 * Hale does not have.
 */

/**
 * The shortest span that can identify anything.
 *
 * Eight characters, because the failures this bound exists for are one and two characters
 * long: "$", "9", "Mon". A quote that short matches somewhere on every page on the
 * internet, so accepting it would turn the whole check into a formality that always
 * passes — which is worse than not having it, since the counts would report a verified
 * corpus.
 */
export const MIN_QUOTE_CHARS = 8;

/** Why a whole row was dropped. A closed vocabulary: it is counted into the audit row and
 * onto the ops dashboard, so it must be stable to aggregate on and safe to emit. */
export type SlotRefusalReason =
  | 'bad_citation'
  | 'uncited_page'
  | 'incomplete_row'
  | 'no_backed_fact';

/** Why one fact inside a surviving row was dropped. */
export type FactRefusalReason =
  | 'no_quote'
  | 'quote_too_short'
  | 'quote_absent'
  | 'source_not_read';

export interface RefutationResult {
  /** The rows that survived, in the shape the composer and the share page already read. */
  slots: DeepSlot[];
  slotsRefused: number;
  factsRefused: number;
  slotReasons: Record<SlotRefusalReason, number>;
  factReasons: Record<FactRefusalReason, number>;
}

/**
 * Page identity, forgiven for the things that are not identity.
 *
 * A scheme, a `www.`, a trailing slash and a fragment are four ways of writing the same
 * page, and a model that read `https://www.town.ca/rec/` off a link and cites
 * `https://town.ca/rec` has cited the page it read. A PATH is identity and is not
 * forgiven — `/rec` and `/rec/fees` are two pages, and the whole gate turns on being able
 * to say which one a fact came off.
 */
function pageKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/#.*$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Text identity, forgiven for the things a page renders and a model retypes.
 *
 * Whitespace collapses because an HTML table cell arrives as three spaces here and a
 * newline there; typographic punctuation folds to ASCII because a page's en dash comes
 * back as a hyphen through half the fetch pipeline. `plainText` already owns that second
 * mapping for the SMS budget, so the two readings of "same characters" cannot drift apart.
 */
function normalise(text: string): string {
  return plainText(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function field(value: unknown): string {
  return typeof value === 'string' ? plainText(value).trim() : '';
}

/** Only an absolute http(s) URL counts as a citation — the same fail-closed rule the
 * public share surface applies to a sourceUrl (village/public.ts), and deep.ts's. */
function citation(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\/\S+$/i.test(raw) ? raw : null;
}

interface FactVerdict {
  value: string | null;
  refusal: FactRefusalReason | null;
}

/**
 * ONE FACT, TRIED — against ITS OWN page.
 *
 * An absent fact is not a refusal: a page that never published a price is the ordinary
 * case and the composer says so. What is refused is a fact ASSERTED without a span, with
 * a span too small to mean anything, with a span naming a page nobody opened, or with a
 * span that is not on the page it names.
 *
 * THE FACT NAMES ITS OWN PAGE, defaulting to the row's. That default is what makes the
 * ordinary single-page row simple, and the override is what makes the merge possible at
 * all: the fee is on the venue's table and the registration date is on the town's portal,
 * and a rule that forced both to be quoted off one URL would refuse whichever fact did not
 * live there — which is a gate deleting the exact thing the fan-out was built to find.
 */
function tryFact(
  value: unknown,
  quote: unknown,
  source: unknown,
  rowUrl: string,
  byPage: ReadonlyMap<string, string>,
): FactVerdict {
  const stated = field(value);
  if (stated === '') return { value: null, refusal: null };

  const span = typeof quote === 'string' ? quote.trim() : '';
  if (span === '') return { value: null, refusal: 'no_quote' };

  const needle = normalise(span);
  if (needle.length < MIN_QUOTE_CHARS) return { value: null, refusal: 'quote_too_short' };

  const cited = citation(source) ?? rowUrl;
  const pageText = byPage.get(pageKey(cited));
  if (pageText === undefined) return { value: null, refusal: 'source_not_read' };
  if (!pageText.includes(needle)) return { value: null, refusal: 'quote_absent' };
  return { value: stated, refusal: null };
}

/**
 * Try to break every row, and hand back only what survived.
 *
 * `pages` is EXACTLY the text the synthesis was given — the bounded page notes from the
 * fan-out, not the provider's original response. That identity is load-bearing: checking
 * against more text than the synthesis saw would pass a fact it could not have read, and
 * checking against less would refuse one it did.
 */
export function refuteSlots(
  rows: readonly SynthesisRow[],
  pages: ReadonlyArray<{ url: string; text: string }>,
): RefutationResult {
  const byPage = new Map<string, string>();
  for (const page of pages) {
    const key = pageKey(page.url);
    // One page fetched twice (two legs can surface the same URL) is one body of evidence;
    // the longer read wins, because a truncated one is a subset of it.
    const existing = byPage.get(key) ?? '';
    const text = normalise(page.text);
    if (text.length > existing.length) byPage.set(key, text);
  }

  const slots: DeepSlot[] = [];
  const slotReasons: Record<SlotRefusalReason, number> = {
    bad_citation: 0,
    uncited_page: 0,
    incomplete_row: 0,
    no_backed_fact: 0,
  };
  const factReasons: Record<FactRefusalReason, number> = {
    no_quote: 0,
    quote_too_short: 0,
    quote_absent: 0,
    source_not_read: 0,
  };
  let slotsRefused = 0;
  let factsRefused = 0;

  const refuse = (reason: SlotRefusalReason) => {
    slotReasons[reason] += 1;
    slotsRefused += 1;
  };

  for (const row of rows) {
    const sourceUrl = citation(row.source_url);
    if (sourceUrl === null) {
      refuse('bad_citation');
      continue;
    }
    if (!byPage.has(pageKey(sourceUrl))) {
      refuse('uncited_page');
      continue;
    }
    const name = field(row.name);
    const ageFit = field(row.age_fit);
    const sourceName = field(row.source_name);
    if (name === '' || ageFit === '' || sourceName === '') {
      refuse('incomplete_row');
      continue;
    }

    const when = tryFact(row.when, row.when_quote, row.when_source, sourceUrl, byPage);
    const price = tryFact(row.price, row.price_quote, row.price_source, sourceUrl, byPage);
    const registration = tryFact(
      row.registration,
      row.registration_quote,
      row.registration_source,
      sourceUrl,
      byPage,
    );
    for (const verdict of [when, price, registration]) {
      if (verdict.refusal === null) continue;
      factReasons[verdict.refusal] += 1;
      factsRefused += 1;
    }

    if (when.value === null && price.value === null && registration.value === null) {
      refuse('no_backed_fact');
      continue;
    }

    slots.push({
      name,
      ageFit,
      when: when.value,
      price: price.value,
      registration: registration.value,
      sourceName,
      sourceUrl,
      // Stamped by CODE. There is no argument through which the model could claim this
      // was verified by us — the same two-tier sourcing the inline lane holds.
      source: 'web',
    });
  }

  if (slotsRefused > 0 || factsRefused > 0) {
    // COUNTS, never a venue and never a URL: this line is read by ops and the whole
    // reason it exists is that a lane silently dropping rows looks identical to a lane
    // finding nothing (rule #1, rule #11).
    console.error(
      { slotsRefused, factsRefused, slotReasons, factReasons },
      'activity refutation: rows refused before composing',
    );
  }

  return { slots, slotsRefused, factsRefused, slotReasons, factReasons };
}
