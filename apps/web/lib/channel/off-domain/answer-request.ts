import type Anthropic from '@anthropic-ai/sdk';
import type { ReplyLanguage } from './medical';

/**
 * The general answer's REQUESTS: what each of its three calls is sent, and the
 * deterministic scrub that runs under the sanitizer (see answer.ts for the lane).
 *
 * This file imports nothing from the web app at runtime, on purpose. The eval
 * (apps/worker/evals/run-general-answer-eval.mjs) cannot resolve the app's `~/` alias,
 * and it used to keep its own copy of every shape here. It loads this file instead, so a
 * recording is the request production sends and not a copy that can drift from it.
 */

/**
 * What happened to the live search this turn. `searched` is the only one that put
 * research in front of the compose. `missing_detail` is a question no search could
 * answer as asked, so none was made and the compose asks for what is missing. The three
 * after it are the ways a question that needed a search went without one — the flag is
 * dark, the call failed, the call returned nothing to stand on — each logged by name and
 * each answered by the compose saying plainly that it cannot check right now.
 */
export type LiveSearch =
  | 'not_needed'
  | 'searched'
  | 'missing_detail'
  | 'search_off'
  | 'search_failed'
  | 'nothing_usable';

/**
 * A question Hale could not answer yet, as it is kept on the reply that said so: the
 * question with the family already taken out of it, and what it was missing. Never the
 * parent's own words.
 */
export interface PendingAsk {
  question: string;
  missing: string;
}

/** The family's own city and country: what leaves for a search about where a family is
 * (founder, 2026-10-12), never the postal code, never anything finer than the city. The
 * province or state goes with them only when the city's name alone is more than one
 * place (Sloane, 2026-10-12; place.ts). */
export interface HomePlace {
  city: string;
  provinceOrState?: string;
  country: string;
}

/**
 * The compose call's ceiling, thinking and reply together, and the one bound on what goes
 * out: forceToolJson throws on a max_tokens cutoff, and a reply cut off there is swapped
 * for the fixed line. It was the medical compose's 1,024, and about one compose in five
 * of this lane's spent that thinking and had to be asked again with thinking off
 * (structured.ts), so the lane has its own, with room for the thinking to finish. There
 * is no segment or character cap on the reply: a correct answer that ran long is still
 * the answer.
 */
export const ANSWER_MAX_TOKENS = 4096;

/** What the sanitizer may answer. `no` makes no search; everything else, on the list or
 * off it, is a question that needed one. */
const SEARCH_READINGS = ['yes', 'no', 'unsure', 'missing_detail'] as const;

export const sanitizeJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  // The language first: it is read off the parent's words before they are rewritten.
  // Whether this text answers a pending ask next, because the question it writes depends
  // on it. What is missing and what is current before the verdict: a reading that names
  // what it is judging on first.
  properties: {
    language: { type: 'string' },
    answers_pending: { type: 'string', enum: ['yes', 'no', 'nothing_pending'] },
    question: { type: 'string' },
    missing_detail: { type: 'string' },
    their_place: { type: 'string', enum: ['needed', 'not_needed'] },
    current_fact: { type: 'string' },
    needs_search: { type: 'string', enum: [...SEARCH_READINGS] },
  },
  required: [
    'language',
    'answers_pending',
    'question',
    'missing_detail',
    'their_place',
    'current_fact',
    'needs_search',
  ],
};

/**
 * How a reply ends, said on the `answer` field itself, where the model reads it as it
 * writes that field (Sloane, 2026-10-12). general-answer.md says the same thing once, in
 * "How it reads".
 */
export const ANSWER_ENDS_ON_THE_ANSWER =
  'The text message, and nothing but it. Its last words are the answer itself, or with missing_detail the question. Nothing is offered after it, and nothing after it points them somewhere else.';

/**
 * What belongs in each field of a `grounding` entry, said on the field itself, where the
 * model reads it as it writes the entry (Sloane, 2026-10-13; the words are hers). A
 * figure the notes gave for one kind of mortgage went out as the figure for another, and
 * a count that can still grow was written down as settled. general-answer.md says both
 * once, where it describes `grounding`.
 */
const GROUNDING_STATES =
  'the specific as the notes qualify it, with the class, group or date they attach to it.';
const GROUNDING_FROM =
  'the words in research_notes it comes from, or `settled` only for what can no longer change. A running count, a record or who holds a title today is never `settled`.';

/**
 * The model writes its fields in this order. First its READING of the text:
 * `hurt_ill_or_danger`, `yes` when the question turns out to describe someone hurt, ill
 * or in danger, which hands the turn to the safety door and sends nothing it wrote
 * (answer.ts). Then `grounding`: every specific the answer is about to state, beside the
 * words in the research it comes from (general-answer.md). Only then the answer. All
 * three are required OF THE MODEL. The lane reads the reading and `answer` and nothing
 * else, so the list is never sent, kept or logged, and a reply that arrives without it is
 * still the reply. The eval keeps the whole object with its recording.
 */
export const answerJsonSchema = {
  type: 'object',
  properties: {
    hurt_ill_or_danger: { type: 'string', enum: ['yes', 'no'] },
    grounding: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          states: { type: 'string', description: GROUNDING_STATES },
          from: { type: 'string', description: GROUNDING_FROM },
        },
        required: ['states', 'from'],
      },
    },
    answer: { type: 'string', description: ANSWER_ENDS_ON_THE_ANSWER },
  },
  required: ['hurt_ill_or_danger', 'grounding', 'answer'],
} as const;

/**
 * The sanitize turn's payload — the ONLY call the raw message reaches. `pending` rides
 * along when Hale's last word to this parent left a question open, so the sanitizer can
 * judge whether this text completes it.
 */
export function questionSanitizeUserMessage(
  text: string,
  pending: PendingAsk | null = null,
): string {
  return JSON.stringify(pending === null ? { text } : { text, pending });
}

/** What the search is given: the de-identified question and the date, and the family's
 * city and country only on a turn the sanitizer judged to depend on where they are. */
export function searchUserMessage(input: {
  question: string;
  today: string;
  place?: HomePlace | null;
}): string {
  const place = input.place;
  return JSON.stringify({
    question: input.question,
    today: input.today,
    ...(place
      ? {
          place: {
            city: place.city,
            ...(place.provinceOrState ? { province_or_state: place.provinceOrState } : {}),
            country: place.country,
          },
        }
      : {}),
  });
}

/**
 * What the compose is told about the search. The three ways a needed search did not
 * happen are ONE value here. To the writer they are the same fact — nothing could be
 * checked — and which one it was belongs to the log and the outcome, not to the reply.
 */
export function liveAsTold(
  search: LiveSearch,
): 'searched' | 'not_needed' | 'missing_detail' | 'unavailable' {
  if (search === 'searched' || search === 'not_needed' || search === 'missing_detail') {
    return search;
  }
  return 'unavailable';
}

/**
 * The compose payload. `notes` travels only with a search that found something,
 * `missing` only with a question that left out what its answer depends on.
 */
export function generalAnswerUserMessage(input: {
  question: string;
  language: ReplyLanguage;
  today: string;
  search: LiveSearch;
  notes: string;
  missing: string;
}): string {
  return JSON.stringify({
    question: input.question,
    language: input.language,
    today: input.today,
    live: liveAsTold(input.search),
    ...(input.search === 'searched' ? { research_notes: input.notes } : {}),
    ...(input.search === 'missing_detail' ? { missing: input.missing } : {}),
  });
}

/**
 * FAIL TOWARD LOOKING IT UP: only an explicit `no` skips the search. `unsure`, a missing
 * reading and anything off the list all search, because the failure worth avoiding is a
 * stale fact stated flat.
 */
export function needsSearch(raw: unknown): boolean {
  return raw !== 'no';
}

/** FAIL TOWARD NOT SENDING IT: the family's place goes to a search only on an explicit
 * `needed`. */
export function turnsOnTheirPlace(raw: unknown): boolean {
  return raw === 'needed';
}

/** FAIL TOWARD A NEW QUESTION: a text is read as the reply to a pending ask only on an
 * explicit `yes`. */
export function answersPending(raw: unknown): boolean {
  return raw === 'yes';
}

/**
 * The compose's reading that the text describes someone hurt, ill or in danger. Only an
 * explicit `yes` is that reading: the schema the request carries allows two values, so
 * anything else is a reply that arrived without one, and it is still the reply.
 */
export function describesHurtIllOrDanger(raw: unknown): boolean {
  return raw === 'yes';
}

/**
 * The deterministic floor under the sanitizer, for DIRECT identifiers only: the things
 * that reach one person or one door. It is this lane's own. The medical lane's scrub
 * (medical.ts) also takes out ages and durations, which is right for a clinical query and
 * wrong here: "the 5 year fixed mortgage rate" lost its term to it. A duration, a year,
 * an age with no name beside it and a price are parts of an ordinary question, and none
 * of them is touched.
 *
 * A long or grouped run of digits is taken out whatever it is, because a social insurance
 * or a health card number has no other mark on it. That costs a count in the hundreds of
 * millions its figure, written out plain or in groups of three, and a price that size
 * written in groups after its sign.
 *
 * EVERY PATTERN READS ONE SHAPE OF THE TEXT ({@link oneShape}): a digit is a digit and a
 * dash is a dash however it was typed, and what may stand between two groups of digits
 * is one list ({@link BETWEEN_GROUPS}). What is handed on is the text as it was typed,
 * less what a pattern took out.
 *
 * A name is free-form and stays the sanitizer's job. So does a street written in lower
 * case with its suffix spelled out and more than one word in its name, which no pattern
 * can tell from "a 10 hour road trip".
 */
const BETWEEN_GROUPS = '[-\\s./_]';
const DIRECT_IDENTIFIERS: RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, // email address
  /(?<![\p{L}\p{N}_.%+-])@[a-z_][a-z0-9_.]*[a-z0-9_]/giu, // @handle
  /\+\d[\d\s()./_-]{6,}\d/g, // phone number, international form
  new RegExp(
    `(?<!\\d)(?:1${BETWEEN_GROUPS}?)?\\(?\\d{3}\\)?${BETWEEN_GROUPS}?\\d{3}${BETWEEN_GROUPS}?\\d{4}(?!\\d)`,
    'g',
  ), // phone number, North American
  // The shapes a government or a health number is written in: ten digits grouped four,
  // three, three; nine grouped in threes; and nine or more in a row. Only the last has
  // exemptions, for what one unbroken figure can be: a price, after its currency sign,
  // and the digits of a fraction, after a digit and its decimal point.
  new RegExp(`(?<!\\d)\\d{4}${BETWEEN_GROUPS}\\d{3}${BETWEEN_GROUPS}\\d{3}(?!\\d)`, 'g'), // grouped number, four-three-three
  new RegExp(`(?<!\\d)\\d{3}${BETWEEN_GROUPS}\\d{3}${BETWEEN_GROUPS}\\d{3}(?!\\d)`, 'g'), // grouped number, three-three-three
  /(?<![\d$])(?<!\d\.)\d{9,}(?!\d)/g, // nine or more digits in a row
  /\b[a-z]\d[a-z][ -]?\d[a-z]\d\b/gi, // Canadian postal code
  /\b\d{5}-\d{4}\b/g, // US ZIP+4
  // A bare five digits is a ZIP only where an address puts one: after a state code, or
  // after the word itself. Anywhere else it is a price or a count.
  /(?<=\b[A-Z]{2},?\s{1,2})\d{5}(?!\d)/g, // US ZIP after a state code
  /(?<=\bzip(?:\s?code)?(?:\s+is)?:?\s{1,2})\d{5}(?!\d)/gi, // US ZIP after the word
  // A door: a number, a name of one or two words, and a suffix nobody uses for anything
  // else. In any case, because a text is typed in lower case.
  /(?<![\p{L}\p{N}])\d{1,5}[a-z]?\s+(?:[\p{L}'’.-]+\s+){1,2}(?:st|ave|rd|blvd|cres|hwy|pkwy|street|avenue|boulevard|crescent)\b\.?/giu,
  // The same door with a suffix that is also an ordinary word ("a 10 hour road trip", "a
  // 5 minute drive"), so here the name must be capitalized.
  /(?<![\p{L}\p{N}])\d{1,5}[a-z]?\s+(?:\p{Lu}[\p{L}'’.-]*\s+){1,3}(?:[Rr]oad|[Dd]rive|[Cc]ourt|[Ll]ane|[Ww]ay|[Pp]lace|[Tt]errace|[Tt]rail|[Cc]ircle|[Ss]quare|[Hh]ighway|[Pp]arkway|Dr|Ct|Ln)\b\.?/gu,
];
const REDACTED = '[redacted]';

const ANY_DASH = /[\p{Dash_Punctuation}\u2212]/gu;

/**
 * One character as every pattern reads it: its compatibility form (Unicode NFKC, so a
 * full-width digit is the digit and a no-break space is a space), with any dash or minus
 * sign as a hyphen.
 */
function oneShape(char: string): string {
  return char.normalize('NFKC').replace(ANY_DASH, '-');
}

/** What one pattern takes out of `text`. The pattern is matched against the one shape,
 * and each character of the text any part of a match was read from goes with it. */
function redact(text: string, pattern: RegExp): string {
  const chars = Array.from(text, (char) => ({ char, shape: oneShape(char) }));
  const matches = Array.from(
    chars
      .map(({ shape }) => shape)
      .join('')
      .matchAll(pattern),
    (match) => ({ start: match.index, end: match.index + match[0].length }),
  );
  let scrubbed = '';
  let at = 0;
  let inside: (typeof matches)[number] | undefined;
  for (const { char, shape } of chars) {
    const match = matches.find(({ start, end }) => start < at + shape.length && at < end);
    if (match === undefined) scrubbed += char;
    else if (match !== inside) scrubbed += REDACTED;
    inside = match;
    at += shape.length;
  }
  return scrubbed;
}

export function scrubDirectIdentifiers(text: string): string {
  return DIRECT_IDENTIFIERS.reduce(redact, text);
}
