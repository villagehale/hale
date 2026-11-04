import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Municipality, ProgramDomain } from '@hale/db';
import { z } from 'zod';
import { forceToolJson } from '~/lib/pipeline/structured';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { loadVerifyRegistrationWindowSkill } from './skill';

/**
 * VIL-259 — re-verifying one stored registration window against the municipality's
 * own page.
 *
 * THE SHAPE IS THE SAFETY. The model is asked ONLY what the page says; it is never
 * shown the stored dates, so it cannot be led into agreeing with them and cannot be
 * led into "correcting" them. The comparison is then arithmetic in `compareWindow`,
 * which returns confirmed / discrepancy / unverified and NOTHING a caller could
 * apply to a row. That is what makes "never silently change" a property of the
 * types rather than a promise in a prompt.
 *
 * Two gates stand between a model reading and a founder alert:
 *   1. CORROBORATION — every date arrives bound to its own verbatim quote, and the
 *      quote, the section it sits in and the text that supplied its YEAR must all
 *      appear in the fetched page; inside the quote, the words the model labels as the
 *      date and as the time must each parse, whole, to exactly the values it extracted.
 *      A fabricated date cannot survive a check that looks for it in the source, and a
 *      prior-year date cannot survive a check that the page states that year (M1's
 *      stale-year trap, made structural).
 *   2. THE CONFIDENCE FLOOR — below it the answer is "couldn't verify", never a
 *      guess and never an alarm. A shaky reading that disagrees with the stored row
 *      is not a discrepancy; it is a reading we do not trust.
 */

/** Every municipality in the dataset registers on Toronto wall-clock time. */
export const REGISTRATION_TIME_ZONE = 'America/Toronto';

/** Below this the reading is not used — in either direction. Same floor as the
 * civic hours parser, for the same reason: better silent than wrong about a time. */
export const MIN_VERIFY_CONFIDENCE = 0.7;

// The read transcribes verbatim page quotes (evidence, year_evidence) whose
// length the page dictates, so a dense page can overrun a tight ceiling — a
// truncated answer that surfaced as "extract_failed". No finite ceiling makes
// truncation impossible while those fields are unbounded; forceToolJson's
// stop_reason guard is the real fix, this is headroom over observed ~600-tok reads.
// Exported so the eval sends the ceiling production sends.
export const EXTRACTION_MAX_TOKENS = 2048;

/** The wall clock a date with no printed time is anchored at: the start of that local
 * day, which asserts no time the page did not print. */
export const DATE_ONLY_WALL_CLOCK = '00:00';

/** Why a page yielded no dates for the cycle asked about. Each is a real, common
 * state of a municipal page — none of them is an error. `no_year_stated` is no longer
 * an extraction answer (a yearless date is a partial date now); it stays here because
 * stored readings carry it. */
export type UnfoundReason =
  | 'announced_later'
  | 'different_cycle_only'
  | 'no_year_stated'
  | 'not_published';

/** The slot the model put an opening in — its eligibility verdict. */
export type AiDateKind = 'preview' | 'resident_open' | 'general_open' | 'unclassified_open';

/** A date as the page prints it: the verbatim words it was read from, the characters of
 * those words that state the date and the time, a local calendar day, and a wall-clock time
 * only where the page actually publishes one. */
export interface PublishedDate {
  quote: string;
  /** The characters of `quote` that state the date (`Aug. 11`, `lundi 7 décembre 2026`). */
  dateText: string;
  /** The characters of `quote` that state the time, or null when the page prints none. */
  timeText: string | null;
  date: string;
  time: string | null;
}

/** A printed date whose year (or day) the page does not establish. It is a quote, never
 * a date field. */
export interface PartialRegistrationDate {
  kind: AiDateKind;
  quote: string;
}

/** What the page says, as read by the skill — before any comparison. */
export interface ExtractedWindow {
  found: boolean;
  reason: UnfoundReason | null;
  cycleOnPage: string | null;
  /** The page text that supplies the YEAR for these dates. The stale-year anchor. */
  yearEvidence: string | null;
  evidence: string | null;
  preview: PublishedDate | null;
  residentOpen: PublishedDate | null;
  generalOpen: PublishedDate | null;
  /** An opening the page attaches no eligibility label to. */
  unclassifiedOpen: PublishedDate | null;
  partialDates: readonly PartialRegistrationDate[];
  /** IANA zone the page states, with the page words that state it. Unchecked here. */
  timeZone: string | null;
  timeZoneEvidence: string | null;
  note: string | null;
  confidence: number;
}

/** The stored row under review. A read-only projection of registration_windows —
 * deliberately not the row type, so nothing here can be handed back to an update. */
export interface StoredWindow {
  id: string;
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  /** Null is the city-wide row. The sweep passes it through so an inferred field
   * is looked up on the district row it was inferred for. */
  district: string | null;
  previewAt: Date | null;
  residentOpenAt: Date | null;
  openAt: Date;
  sourceUrl: string;
  verifiedAt: Date;
}

export type VerifyField = 'previewAt' | 'residentOpenAt' | 'openAt';

/** One field where the page and the stored row disagree. Carries both instants so
 * a human can read them; carries no instruction. */
export interface FieldDiff {
  field: VerifyField;
  stored: Date | null;
  published: Date;
}

export type UnverifiedReason =
  | UnfoundReason
  | 'low_confidence'
  | 'uncorroborated'
  | 'no_dates_for_cycle'
  /** Every field the page backed is one the DATASET marks as inferred, so there is
   * nothing here that was actually read for this row. Distinct from
   * `no_dates_for_cycle`, which means the page said nothing: this page did speak, and
   * what it said is not evidence for a value nobody read off it. */
  | 'inferred_unconfirmed'
  | 'fetch_failed'
  | 'extract_failed'
  /** The page printed dates for the cycle, but none with a year (or day) it states. */
  | 'incomplete_date';

/**
 * The three outcomes, and the whole contract of this module.
 *
 * `confirmed` is the ONLY one that earns a write, and the only write it earns is
 * `verified_at`. `discrepancy` deliberately has no field a caller could spread onto
 * an update — the dates live inside `diffs`, next to the stored value they differ
 * from, which is a shape you read rather than apply.
 */
export type VerifyOutcome =
  | { kind: 'confirmed'; fields: VerifyField[] }
  | { kind: 'discrepancy'; diffs: FieldDiff[]; evidence: string }
  | { kind: 'unverified'; reason: UnverifiedReason };

/**
 * The instant a published date names. A date with no published time is the START of
 * that local day — the seed's own convention, and the only reading that asserts no
 * time the town did not print.
 */
export function publishedInstant(published: Pick<PublishedDate, 'date' | 'time'>): Date {
  return zonedLocalInstant(
    published.date,
    published.time ?? DATE_ONLY_WALL_CLOCK,
    REGISTRATION_TIME_ZONE,
  );
}

/** Fold away the differences an HTML strip and a re-typed quote legitimately
 * introduce — Unicode composition and width (NFKC: a decomposed accent, a no-break
 * space, a full-width digit), case, dashes and quotes, runs of whitespace — while
 * keeping every digit and letter. Applied to BOTH sides of every quote check. A wrong
 * DATE cannot survive this; a re-typed dash can. */
export function normalizeQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Every four-digit year mentioned in a run of text. */
function yearsIn(text: string): Set<string> {
  return new Set(text.match(/\b(19|20)\d{2}\b/g) ?? []);
}

/** Every complete date a reading carries, in slot order. */
export function completeDates(extracted: ExtractedWindow): PublishedDate[] {
  return [
    extracted.preview,
    extracted.residentOpen,
    extracted.generalOpen,
    extracted.unclassifiedOpen,
  ].filter((published): published is PublishedDate => published !== null);
}

/** Why one complete date was refused. Every one makes the reading `uncorroborated`, and
 * each is logged by its own name. */
export type DateSpanRefusal =
  | 'span_missing'
  | 'span_overlap'
  | 'date_unparsed'
  | 'date_ambiguous'
  | 'date_mismatch'
  | 'time_unparsed'
  | 'time_mismatch';

/** Month names and abbreviations, lower-cased, in English, French and Spanish. Where two
 * languages share a word (`mar`, `jun`) it names the same month. */
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  janvier: 1,
  janv: 1,
  enero: 1,
  ene: 1,
  february: 2,
  feb: 2,
  février: 2,
  févr: 2,
  fév: 2,
  febrero: 2,
  march: 3,
  mar: 3,
  mars: 3,
  marzo: 3,
  april: 4,
  apr: 4,
  avril: 4,
  avr: 4,
  abril: 4,
  abr: 4,
  may: 5,
  mai: 5,
  mayo: 5,
  june: 6,
  jun: 6,
  juin: 6,
  junio: 6,
  july: 7,
  jul: 7,
  juillet: 7,
  juil: 7,
  julio: 7,
  august: 8,
  aug: 8,
  août: 8,
  agosto: 8,
  ago: 8,
  september: 9,
  sept: 9,
  sep: 9,
  septembre: 9,
  septiembre: 9,
  setiembre: 9,
  october: 10,
  oct: 10,
  octobre: 10,
  octubre: 10,
  november: 11,
  nov: 11,
  novembre: 11,
  noviembre: 11,
  december: 12,
  dec: 12,
  décembre: 12,
  déc: 12,
  diciembre: 12,
  dic: 12,
};

/** Weekday names and abbreviations a date may lead with. They are read past, not checked. */
const WEEKDAYS = [
  'monday',
  'mon',
  'tuesday',
  'tues',
  'tue',
  'wednesday',
  'wed',
  'thursday',
  'thurs',
  'thur',
  'thu',
  'friday',
  'fri',
  'saturday',
  'sat',
  'sunday',
  'sun',
  'lundi',
  'lun',
  'mardi',
  'mar',
  'mercredi',
  'mer',
  'jeudi',
  'jeu',
  'vendredi',
  'ven',
  'samedi',
  'sam',
  'dimanche',
  'dim',
  'lunes',
  'martes',
  'miércoles',
  'mié',
  'jueves',
  'jue',
  'viernes',
  'vie',
  'sábado',
  'sáb',
  'domingo',
  'dom',
];

const alternation = (words: readonly string[]) =>
  [...words].sort((a, b) => b.length - a.length).join('|');
const WEEKDAY = `(?:(?:${alternation(WEEKDAYS)})\\.?,?\\s)?`;
const MONTH = `(${alternation(Object.keys(MONTHS))})\\.?`;
const DAY = '(\\d{1,2})(?:st|nd|rd|th|er)?';
const YEAR = '(\\d{4})';

interface PrintedDate {
  year: number | null;
  month: number;
  day: number;
}

/** The date grammar: the whole span must match one row, or it is not a date. */
const DATE_FORMS: ReadonlyArray<{
  pattern: RegExp;
  read: (m: RegExpMatchArray) => PrintedDate | 'date_ambiguous';
}> = [
  {
    // `Aug. 11`, `Aug, 3`, `Tuesday, November 17, 2026`, `August 11th`
    pattern: new RegExp(`^${WEEKDAY}${MONTH},?\\s?${DAY}(?:,?\\s${YEAR})?$`, 'u'),
    read: (m) => named(m[1], m[2], m[3]),
  },
  {
    // `lundi 7 décembre 2026`, `11 de agosto de 2026`, `1er août`
    pattern: new RegExp(`^${WEEKDAY}${DAY}\\s(?:de\\s)?${MONTH}(?:,?\\s(?:de\\s)?${YEAR})?$`, 'u'),
    read: (m) => named(m[2], m[1], m[3]),
  },
  {
    // `2026-08-11`, `2026/08/11`
    pattern: /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/u,
    read: (m) => numbers(m[1], m[3], m[4]),
  },
  {
    // `2026年8月11日`, `8月11日`
    pattern: /^(?:(\d{4})\s?年\s?)?(\d{1,2})\s?月\s?(\d{1,2})\s?日$/u,
    read: (m) => numbers(m[1], m[2], m[3]),
  },
  {
    // `15/08/2026` or `08/15/2026` — read only when the day cannot be the month.
    pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u,
    read: (m) => {
      const [first, second] = [Number(m[1]), Number(m[2])];
      if (first !== second && first <= 12 && second <= 12) return 'date_ambiguous';
      return first > 12 ? numbers(m[3], m[2], m[1]) : numbers(m[3], m[1], m[2]);
    },
  },
];

function named(month: string | undefined, day: string | undefined, year: string | undefined) {
  return {
    year: year === undefined ? null : Number(year),
    month: MONTHS[month ?? ''] ?? 0,
    day: Number(day),
  };
}

function numbers(year: string | undefined, month: string | undefined, day: string | undefined) {
  return { year: year === undefined ? null : Number(year), month: Number(month), day: Number(day) };
}

function parseDateSpan(span: string): PrintedDate | 'date_unparsed' | 'date_ambiguous' {
  for (const { pattern, read } of DATE_FORMS) {
    const match = span.match(pattern);
    if (match === null) continue;
    const printed = read(match);
    if (printed === 'date_ambiguous') return printed;
    const valid =
      printed.month >= 1 && printed.month <= 12 && printed.day >= 1 && printed.day <= 31;
    return valid ? printed : 'date_unparsed';
  }
  return 'date_unparsed';
}

const MERIDIEM = '([ap])\\.?\\s?m\\.?';

/** The clock grammar: the whole span must match one row, or it is not a time. Words for a
 * time (`noon`, `midi`) and other separators (`8.30`) are not in it. */
const CLOCK_FORMS: ReadonlyArray<{
  pattern: RegExp;
  read: (m: RegExpMatchArray) => [hour: string, minute: string, meridiem: string | undefined];
}> = [
  // `6:30`, `6:30 AM`, `7:00 p.m.`
  {
    pattern: new RegExp(`^(\\d{1,2}):(\\d{2})(?:\\s?${MERIDIEM})?$`, 'u'),
    read: (m) => [m[1] ?? '', m[2] ?? '', m[3]],
  },
  // `7 a.m.`, `9pm`
  { pattern: new RegExp(`^(\\d{1,2})\\s?${MERIDIEM}$`, 'u'), read: (m) => [m[1] ?? '', '0', m[2]] },
  // `20h00`, `18 h 30`, `9 h`
  { pattern: /^(\d{1,2})\s?h(?:\s?(\d{2}))?$/u, read: (m) => [m[1] ?? '', m[2] ?? '0', undefined] },
  // `8点`, `8点30分`, `8点半`
  {
    pattern: /^(\d{1,2})\s?点(?:\s?(\d{1,2})\s?分|(半))?$/u,
    read: (m) => [m[1] ?? '', m[3] ? '30' : (m[2] ?? '0'), undefined],
  },
  // `8時`, `8時30分`
  {
    pattern: /^(\d{1,2})\s?時(?:\s?(\d{1,2})\s?分)?$/u,
    read: (m) => [m[1] ?? '', m[2] ?? '0', undefined],
  },
  // `8시`, `8시 30분`
  {
    pattern: /^(\d{1,2})\s?시(?:\s?(\d{1,2})\s?분)?$/u,
    read: (m) => [m[1] ?? '', m[2] ?? '0', undefined],
  },
];

/** The 24-hour `HH:MM` a clock span states, or null when it states none. */
function parseClockSpan(span: string): string | null {
  for (const { pattern, read } of CLOCK_FORMS) {
    const match = span.match(pattern);
    if (match === null) continue;
    const [hourText, minuteText, meridiem] = read(match);
    let hour = Number(hourText);
    const minute = Number(minuteText);
    if (minute > 59) return null;
    if (meridiem !== undefined) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    } else if (hour > 23) {
      return null;
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

/** The positions an expression may start or end at: anywhere but inside a run of digits
 * or a run of Latin letters. */
function boundaries(text: string): number[] {
  const run = (char: string | undefined): 'digit' | 'latin' | null => {
    if (char === undefined) return null;
    if (/\d/.test(char)) return 'digit';
    return /\p{Script=Latin}/u.test(char) ? 'latin' : null;
  };
  const cuts: number[] = [];
  for (let at = 0; at <= text.length; at++) {
    const before = run(text[at - 1]);
    if (before === null || before !== run(text[at])) cuts.push(at);
  }
  return cuts;
}

/** Every expression of one grammar that `text` prints, read whole; an expression inside a
 * longer one (`05 p.m.` inside `1:05 p.m.`, `Aug. 11` inside `Tuesday, Aug. 11`) is part of
 * it, not a second one. */
function expressionsIn<T>(text: string, read: (span: string) => T | null): T[] {
  const cuts = boundaries(text);
  const found: Array<{ start: number; end: number; value: T }> = [];
  for (const start of cuts) {
    for (const end of cuts) {
      if (end <= start || end - start > MAX_CHARS.span) continue;
      const value = read(text.slice(start, end));
      if (value !== null) found.push({ start, end, value });
    }
  }
  return found
    .filter((a) => !found.some((b) => b !== a && b.start <= a.start && a.end <= b.end))
    .map(({ value }) => value);
}

function dateExpression(span: string): PrintedDate | 'date_ambiguous' | null {
  const printed = parseDateSpan(span);
  return printed === 'date_unparsed' ? null : printed;
}

/** Every index at which `needle` starts in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/**
 * Why a complete date is not the one its own labelled spans state, or null when it is.
 *
 * The model labels the characters of its quote that state the date (`dateText`) and the
 * time (`timeText`). Code never guesses which printed number is which: each span must be
 * in the quote, the two must sit in separate characters, the date span must parse WHOLE
 * under the date grammar to exactly this month and day (and year, when it prints one), and
 * the time span WHOLE under the clock grammar to exactly this HH:MM. A null time needs a
 * null time span and the other way round.
 *
 * The spans are the model's labels; the quote is the page's words. So every date and every
 * clock the quote prints, read whole by the same grammars, must state the extracted value
 * too: a label cannot take the day from one expression and leave a conflicting year
 * (`Aug. 11, 2025`), a second date or a second clock beside it. A bare number outside the
 * spans (an age, a room) is in neither grammar, so it is never read as a date or a clock.
 */
export function dateSpanRefusal(published: PublishedDate): DateSpanRefusal | null {
  if (published.time !== null && published.timeText === null) return 'span_missing';
  if (published.time === null && published.timeText !== null) return 'time_mismatch';

  const quote = normalizeQuote(published.quote);
  const dateSpan = normalizeQuote(published.dateText);
  const timeSpan = published.timeText === null ? null : normalizeQuote(published.timeText);
  const dateAt = occurrences(quote, dateSpan);
  const timeAt = timeSpan === null ? [] : occurrences(quote, timeSpan);
  if (dateAt.length === 0 || (timeSpan !== null && timeAt.length === 0)) return 'span_missing';
  if (
    timeSpan !== null &&
    !dateAt.some((d) => timeAt.some((t) => d + dateSpan.length <= t || t + timeSpan.length <= d))
  ) {
    return 'span_overlap';
  }

  const printed = parseDateSpan(dateSpan);
  if (typeof printed === 'string') return printed;
  const [year, month, day] = published.date.split('-').map(Number);
  const statesDate = (date: PrintedDate | 'date_ambiguous') =>
    date !== 'date_ambiguous' &&
    date.month === month &&
    date.day === day &&
    (date.year === null || date.year === year);
  if (!statesDate(printed)) return 'date_mismatch';

  if (timeSpan !== null) {
    const clock = parseClockSpan(timeSpan);
    if (clock === null) return 'time_unparsed';
    if (clock !== published.time) return 'time_mismatch';
  }

  if (!expressionsIn(quote, dateExpression).every(statesDate)) return 'date_mismatch';
  if (!expressionsIn(quote, parseClockSpan).every((clock) => clock === published.time)) {
    return 'time_mismatch';
  }
  return null;
}

/**
 * Whether a reading is backed by the fetched page. Binary, like the civic hours
 * gate: there is no partial credit for a date that is nearly in the source.
 *
 * Checks, in the order they can fail:
 *   - the section the dates were read from appears in the page;
 *   - every date's own quote, complete or partial, appears in the page;
 *   - the text supplying the year, when given, appears in the page — and it is required,
 *     and must state each complete date's year, as soon as there is a complete date;
 *   - each complete date is the one its own labelled date and time spans state
 *     (`dateSpanRefusal`), each refusal logged by name.
 *
 * The year check is the stale-year trap made structural. A model that rolls last
 * year's table forward has to produce a year the page does not state for that
 * cycle, and cannot.
 */
export function corroborationFailure(
  pageText: string,
  extracted: ExtractedWindow,
): 'uncorroborated' | null {
  if (!extracted.found) return null;

  const page = normalizeQuote(pageText);
  const onPage = (quote: string | null) =>
    quote !== null && quote.trim() !== '' && page.includes(normalizeQuote(quote));

  if (!onPage(extracted.evidence)) return 'uncorroborated';
  const complete = completeDates(extracted);
  const quotes = [...complete, ...extracted.partialDates].map((published) => published.quote);
  if (!quotes.every(onPage)) return 'uncorroborated';

  const yearEvidence = extracted.yearEvidence;
  if (yearEvidence !== null && !onPage(yearEvidence)) return 'uncorroborated';
  if (complete.length > 0) {
    if (yearEvidence === null) return 'uncorroborated';
    const statedYears = yearsIn(normalizeQuote(yearEvidence));
    if (complete.some((published) => !statedYears.has(published.date.slice(0, 4)))) {
      return 'uncorroborated';
    }
  }
  const slots = [
    ['preview', extracted.preview],
    ['resident_open', extracted.residentOpen],
    ['general_open', extracted.generalOpen],
    ['unclassified_open', extracted.unclassifiedOpen],
  ] as const;
  for (const [slot, published] of slots) {
    if (published === null) continue;
    const refusal = dateSpanRefusal(published);
    if (refusal !== null) {
      console.info({ refusal, slot }, 'registration date: refused');
      return 'uncorroborated';
    }
  }
  return null;
}

/** The stored counterpart of each published field. */
const FIELD_MAP = [
  ['preview', 'previewAt'],
  ['residentOpen', 'residentOpenAt'],
  ['generalOpen', 'openAt'],
] as const satisfies ReadonlyArray<readonly [keyof ExtractedWindow, VerifyField]>;

/**
 * Compare what the page publishes with what is stored.
 *
 * ONLY THE FIELDS THE PAGE STATES ARE COMPARED. A field the page is silent about is
 * not evidence of anything — Toronto prints only its resident date and derives the
 * general open from a written rule, so demanding all three would make its rows
 * permanently unverifiable while proving nothing.
 */
export function compareWindow(stored: StoredWindow, extracted: ExtractedWindow): VerifyOutcome {
  if (!extracted.found) {
    return { kind: 'unverified', reason: extracted.reason ?? 'not_published' };
  }
  // The floor is checked BEFORE the comparison on purpose: a reading we do not
  // trust must not be able to raise an alarm either.
  if (extracted.confidence < MIN_VERIFY_CONFIDENCE) {
    return { kind: 'unverified', reason: 'low_confidence' };
  }
  if (completeDates(extracted).length === 0 && extracted.partialDates.length > 0) {
    return { kind: 'unverified', reason: 'incomplete_date' };
  }

  // An opening the page leaves unlabelled is compared as the general open, exactly as
  // it was before the model could say it was unlabelled; the VIL-347 rule below then
  // decides whether it is really the resident morning.
  const labelled = {
    ...extracted,
    generalOpen: extracted.generalOpen ?? extracted.unclassifiedOpen,
  };

  // VIL-347 · A PAGE THAT STATES ONE UNLABELLED DATE. Some municipalities tier a cycle on
  // their course pages and print a single date on the page a parent is actually sent to:
  // Markham's "Register starting Aug. 11 at 6:30 AM" is the RESIDENT morning, and everyone
  // else registers on the 12th. Read as a general open it disagrees with the row forever.
  //
  // So: where the page names NO resident date, and the one date it does name is the date
  // stored as this row's resident open, that is which date it is. The general open — which
  // this page never states — goes back to being a field the page is silent about.
  //
  // This is the doctrine directly above, applied to a page that mislabels rather than
  // omits, and it is deliberately not a list of towns whose page is known to do this: a
  // list is a per-cycle chore that re-alarms every season until someone tops it up. It
  // fires only on a date that MATCHES something already stored and still has to produce a
  // `matched` field, so it cannot quiet a row whose resident date is wrong — that row
  // matches nothing and reports its diff exactly as before.
  const reading =
    labelled.residentOpen === null &&
    labelled.generalOpen !== null &&
    stored.residentOpenAt !== null &&
    publishedInstant(labelled.generalOpen).getTime() === stored.residentOpenAt.getTime()
      ? { ...labelled, residentOpen: labelled.generalOpen, generalOpen: null }
      : labelled;

  const matched: VerifyField[] = [];
  const diffs: FieldDiff[] = [];

  for (const [source, field] of FIELD_MAP) {
    const published = reading[source] as PublishedDate | null;
    if (published === null) continue;
    const publishedAt = publishedInstant(published);
    const storedAt = stored[field];
    if (storedAt !== null && storedAt.getTime() === publishedAt.getTime()) {
      matched.push(field);
    } else {
      diffs.push({ field, stored: storedAt, published: publishedAt });
    }
  }

  if (matched.length === 0 && diffs.length === 0) {
    return { kind: 'unverified', reason: 'no_dates_for_cycle' };
  }
  if (diffs.length > 0) {
    return { kind: 'discrepancy', diffs, evidence: extracted.evidence ?? '' };
  }
  return { kind: 'confirmed', fields: matched };
}

/**
 * VIL-347 — an inferred field is not evidence, so it cannot be confirmed.
 *
 * Some rows hold a value they did not read off their own source: Markham's swim and camp
 * rows carry the one-day resident head start from the REC: Programs course pages of the
 * same combined cycle, because no swim or camp course page for it is checked in. The
 * dataset says so in `inferredFields`, and this is where that marker bites — otherwise
 * the unlabelled-single-date rule above would hand those rows a `residentOpenAt` match off
 * a page that never tiers anything, turning an inference into a confirmation by arithmetic.
 *
 * A DISCREPANCY IS NEVER SOFTENED. A page that contradicts an inference is exactly the
 * evidence that would retire it, and it has to reach the founder digest intact.
 */
export function withoutInferredEvidence(
  outcome: VerifyOutcome,
  inferred: readonly VerifyField[],
): VerifyOutcome {
  if (outcome.kind !== 'confirmed' || inferred.length === 0) return outcome;
  const fields = outcome.fields.filter((field) => !inferred.includes(field));
  if (fields.length === 0) return { kind: 'unverified', reason: 'inferred_unconfirmed' };
  return { kind: 'confirmed', fields };
}

// ── the model read ───────────────────────────────────────────────────────────

/**
 * The longest text the model may write in each kind of field. The page is untrusted, so
 * no field may carry an unbounded run of it (or an instruction planted in it) downstream:
 * an answer past a bound fails the parse and is named `extract_failed`. The JSON schema
 * states the same bounds to the model.
 */
const MAX_CHARS = {
  /** A section or table row of the page, or the model's account of its labels. */
  passage: 1500,
  /** One sentence, heading or cell: a date's quote, the year or zone evidence. */
  line: 300,
  /** The words of one date or one clock inside a quote, or a date or time value. */
  span: 100,
  /** An IANA zone id. */
  zone: 64,
} as const;

const publishedDateSchema = z.strictObject({
  quote: z.string().trim().min(1).max(MAX_CHARS.line),
  date_text: z.string().max(MAX_CHARS.span),
  time_text: z.string().max(MAX_CHARS.span).nullable(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
});

/** The model has two ways of saying "no date for this field": a plain `null`, and
 * a present object whose date is null (`{date:null,time:null}`) — it flip-flops
 * between them run to run. Both mean the same absence when there is no quote, so the
 * object form collapses to `null` at the parse boundary. A `{date:null}` WITH a quote
 * is not absence: it is a printed date whose year (or day) the page does not establish,
 * and it survives as a partial date (toExtractedWindow). */
const nullableWindowDate = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const { date, quote } = value as { date?: unknown; quote?: unknown };
  return date == null && (typeof quote !== 'string' || quote.trim() === '') ? null : value;
}, publishedDateSchema.nullable());

const extractionSchema = z.strictObject({
  cycle_on_page: z.string().max(MAX_CHARS.line).nullable(),
  evidence: z.string().max(MAX_CHARS.passage).nullable(),
  year_evidence: z.string().max(MAX_CHARS.line).nullable(),
  time_zone_evidence: z.string().max(MAX_CHARS.line).nullable(),
  time_zone: z.string().max(MAX_CHARS.zone).nullable(),
  eligibility_evidence: z.string().max(MAX_CHARS.passage).nullable(),
  preview: nullableWindowDate,
  resident_open: nullableWindowDate,
  general_open: nullableWindowDate,
  unclassified_open: nullableWindowDate,
  note: z.string().max(MAX_CHARS.passage).nullable(),
  found: z.boolean(),
  reason: z.enum(['announced_later', 'different_cycle_only', 'not_published']).nullable(),
  confidence: z.number().min(0).max(1),
});

/** What the MODEL sees. Hand-written alongside the Zod schema above, which is what
 * validates what comes back — the same split the civic hours parser uses. Property
 * order is the order the model writes in: every quote and the eligibility reasoning
 * come before the slots they justify, and the slots before the verdict fields. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cycle_on_page: { type: ['string', 'null'], maxLength: MAX_CHARS.line },
    evidence: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.passage,
      description: 'Verbatim page text of the section the dates were read from.',
    },
    year_evidence: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.line,
      description: 'Verbatim page text stating the YEAR of every complete date.',
    },
    time_zone_evidence: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.line,
      description: 'Verbatim page text naming the time zone or the place the program is in.',
    },
    time_zone: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.zone,
      description: 'IANA time zone that time_zone_evidence establishes; null without it.',
    },
    eligibility_evidence: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.passage,
      description: 'Which label the page attaches to each opening, with the quoted label.',
    },
    preview: { $ref: '#/$defs/publishedDate' },
    resident_open: { $ref: '#/$defs/publishedDate' },
    general_open: { $ref: '#/$defs/publishedDate' },
    unclassified_open: { $ref: '#/$defs/publishedDate' },
    note: {
      type: ['string', 'null'],
      maxLength: MAX_CHARS.passage,
      description: 'What the date fields cannot say, such as a year the page never states.',
    },
    found: { type: 'boolean' },
    reason: {
      type: ['string', 'null'],
      enum: ['announced_later', 'different_cycle_only', 'not_published', null],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'cycle_on_page',
    'evidence',
    'year_evidence',
    'time_zone_evidence',
    'time_zone',
    'eligibility_evidence',
    'preview',
    'resident_open',
    'general_open',
    'unclassified_open',
    'note',
    'found',
    'reason',
    'confidence',
  ],
  $defs: {
    publishedDate: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        quote: {
          type: 'string',
          maxLength: MAX_CHARS.line,
          description: 'The shortest verbatim page text stating this date and its time.',
        },
        date_text: {
          type: 'string',
          maxLength: MAX_CHARS.span,
          description: 'The words of quote, copied exactly, that state the date.',
        },
        time_text: {
          type: ['string', 'null'],
          maxLength: MAX_CHARS.span,
          description: 'The words of quote, copied exactly, that state the time; null if none.',
        },
        date: {
          type: ['string', 'null'],
          maxLength: MAX_CHARS.span,
          description: 'YYYY-MM-DD, or null when the page does not establish the year or day',
        },
        time: {
          type: ['string', 'null'],
          maxLength: MAX_CHARS.span,
          description: '24-hour HH:MM, or null when the page publishes no time',
        },
      },
      required: ['quote', 'date_text', 'time_text', 'date', 'time'],
    },
  },
} as const;

/** The user-message payload. Exported so the eval sends the model byte-identical
 * input to what production sends (the eval imports it). */
export function extractionInput(
  window: Pick<StoredWindow, 'municipality' | 'programDomain' | 'cycleLabel'>,
  pageText: string,
): string {
  return JSON.stringify({
    municipality: window.municipality,
    program_domain: window.programDomain,
    cycle_label: window.cycleLabel,
    page_text: pageText,
  });
}

/** What identifies the cycle to read — all the model is told about the stored row.
 * Deliberately NOT the dates: a model shown the answer cannot be a check on it. */
export type CycleIdentity = Pick<StoredWindow, 'municipality' | 'programDomain' | 'cycleLabel'>;

export interface ExtractDeps {
  client: AgentClient;
}

/** Parse a raw model tool-input into the module's shape. Exported so the parse
 * boundary — the same `extractionSchema` forceToolJson runs in production — is
 * testable directly, including the {date:null} → null collapse. */
export function parseExtraction(raw: unknown): ExtractedWindow {
  return toExtractedWindow(extractionSchema.parse(raw));
}

/** Normalise the skill's snake_case answer into the module's shape. */
export function toExtractedWindow(value: z.infer<typeof extractionSchema>): ExtractedWindow {
  const slots = [
    ['preview', value.preview],
    ['resident_open', value.resident_open],
    ['general_open', value.general_open],
    ['unclassified_open', value.unclassified_open],
  ] as const;
  const complete = (slot: z.infer<typeof publishedDateSchema> | null): PublishedDate | null =>
    slot?.date
      ? {
          quote: slot.quote,
          dateText: slot.date_text,
          timeText: slot.time_text,
          date: slot.date,
          time: slot.time,
        }
      : null;
  return {
    found: value.found,
    reason: value.reason,
    cycleOnPage: value.cycle_on_page,
    yearEvidence: value.year_evidence,
    evidence: value.evidence,
    preview: complete(value.preview),
    residentOpen: complete(value.resident_open),
    generalOpen: complete(value.general_open),
    unclassifiedOpen: complete(value.unclassified_open),
    partialDates: slots.flatMap(([kind, slot]) =>
      slot && slot.date === null ? [{ kind, quote: slot.quote }] : [],
    ),
    timeZone: value.time_zone,
    timeZoneEvidence: value.time_zone_evidence,
    note: value.note,
    confidence: value.confidence,
  };
}

/**
 * Read the dates one municipal page publishes for one stored cycle.
 *
 * The skill is loaded OUTSIDE any catch (as in parseCivicHours): a missing skill
 * file is a deploy bug and must surface as one, never degrade into "this town
 * publishes nothing".
 */
export async function extractPublishedWindow(
  cycle: CycleIdentity,
  pageText: string,
  deps: ExtractDeps,
): Promise<ExtractedWindow> {
  const skill = await loadVerifyRegistrationWindowSkill();
  const { value } = await forceToolJson({
    client: deps.client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: extractionInput(cycle, pageText),
    toolName: 'published_registration_window',
    toolDescription: 'Return the registration dates this page publishes for the named cycle.',
    inputJsonSchema: EXTRACTION_JSON_SCHEMA,
    schema: extractionSchema,
    maxTokens: EXTRACTION_MAX_TOKENS,
  });
  return toExtractedWindow(value);
}

/**
 * Whether a reading is one we may act on at all: corroborated by the page, above
 * the confidence floor, and actually a find with at least one complete date — a
 * reading of yearless dates alone has no date to publish. The discovery leg's gate —
 * the verify leg additionally runs `compareWindow`, which applies the same floor.
 */
export function isTrustworthyFind(pageText: string, extracted: ExtractedWindow): boolean {
  return (
    extracted.found &&
    extracted.confidence >= MIN_VERIFY_CONFIDENCE &&
    completeDates(extracted).length > 0 &&
    corroborationFailure(pageText, extracted) === null
  );
}
