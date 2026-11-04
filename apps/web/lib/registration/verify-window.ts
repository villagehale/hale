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
 *      appear in the fetched page, with the date's numbers the ones its quote prints.
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

/** A date as the page prints it: the verbatim words it was read from, a local calendar
 * day, and a wall-clock time only where the page actually publishes one. */
export interface PublishedDate {
  quote: string;
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
export function publishedInstant(published: Omit<PublishedDate, 'quote'>): Date {
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

/** A digit run in this range is a printed year and can only be read as one. */
const YEAR_RUN = /^(19|20)\d{2}$/;

/** What a printed hour is followed by: its minute after a colon (`8:00`), or a clock
 * word (`8 a.m.`, `20h00`, `9 h`, `8 Uhr`, `8点`, `8時`, `8시`). A bare number is an
 * age, a session, a room — never an hour. */
const CLOCK_AFTER_HOUR = /^(?::\d|\s?(?:h(?![a-z])|[ap]\.?\s?m(?![a-z])|uhr(?![a-z])|[点時时시]))/;

/** The only text a printed minute may sit behind: its hour's colon or clock word. */
const HOUR_TO_MINUTE = /^\s?(?::|h|[点時时시])\s?$/;

/**
 * Whether the numbers a quote prints are exactly this date's numbers, in any language.
 *
 * Only the digits are checked, so a French, Spanish or Japanese quote verifies the same
 * way an English one does, with no month or weekday tables. Every ASCII digit run in the
 * (normalised) quote must be consumed exactly once, and the DATE is read first: a
 * four-digit year (which must be this date's year), the day (required), and the month
 * number wherever the quote prints one beside the day with at most one non-space
 * character between (`11/06`, `2026-06-11`, `6月11`, `11 06 2026`) and no clock form
 * after it. Those runs are the date's and only the date's. The clock comes from what
 * the date leaves, and only from a run the page prints AS a clock (`CLOCK_AFTER_HOUR`):
 * the hour (required when the date has a time; 13-23 may be printed on a 12-hour
 * clock), and the minute — behind the hour's colon or clock word, absent when it is
 * zero and the page prints none (`9 a.m.`, `9 h`). So a date-only `2026-08-11` cannot
 * lend its month to an 08:00 the page never printed, `ages 8` is never 08:00, and a
 * month-valued hour keeps its clock (`Aug. 11, 8 a.m.`). A leftover run fails the date:
 * a time on a date-only reading, a second date or clock in the quote.
 *
 * Known residuals, all fail-closed or caught by the eval's exact equality: a spelled-out
 * month and AM/PM are not checked; a day/hour swap at minute zero with both numbers
 * under 24 is not caught; a day/month swap in an all-numeric date with both numbers
 * 12 or under (`11/08/2026`) is not caught; a clock the pattern does not know
 * (`8.30`, `8 heures`, `noon`), a month number behind a word (`11 de 08 de 2026`),
 * spelled-out numbers and non-ASCII digit systems fail.
 */
function quoteStatesDate(published: PublishedDate): boolean {
  const quote = normalizeQuote(published.quote);
  const runs = Array.from(quote.matchAll(/\d+/g), (match, index) => ({
    index,
    text: match[0],
    value: Number(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }));
  type Run = (typeof runs)[number];
  const joined = (a: Run, b: Run): boolean => {
    const [first, second] = a.start < b.start ? [a, b] : [b, a];
    return quote.slice(first.end, second.start).replace(/\s/g, '').length <= 1;
  };
  const isClock = (run: Run): boolean => CLOCK_AFTER_HOUR.test(quote.slice(run.end));
  const [year, month, day] = published.date.split('-').map(Number);
  const clock = published.time?.split(':').map(Number) ?? null;

  const years = runs.filter((run) => YEAR_RUN.test(run.text));
  if (years.length > 1 || years.some((run) => run.value !== year)) return false;
  const others = runs.filter((run) => !YEAR_RUN.test(run.text));

  const clockConsumes = (rest: readonly Run[]): boolean => {
    if (clock === null) return rest.length === 0;
    const [hour, minute] = clock as [number, number];
    const [hourRun, minuteRun, ...extra] = rest;
    if (hourRun === undefined || extra.length > 0 || !isClock(hourRun)) return false;
    const hourMatches =
      hourRun.value === hour ||
      (hour >= 13 && hourRun.value === hour - 12) ||
      (hour === 0 && hourRun.value === 12);
    if (!hourMatches) return false;
    if (minuteRun === undefined) return minute === 0;
    return (
      HOUR_TO_MINUTE.test(quote.slice(hourRun.end, minuteRun.start)) && minuteRun.value === minute
    );
  };

  return others.some((dayRun) => {
    if (dayRun.value !== day) return false;
    const months = others.filter(
      (run) => run !== dayRun && run.value === month && joined(dayRun, run) && !isClock(run),
    );
    return (months.length > 0 ? months : [null]).some((monthRun) =>
      clockConsumes(others.filter((run) => run !== dayRun && run !== monthRun)),
    );
  });
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
 *   - each complete date's numbers are the ones its quote prints.
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
  if (!complete.every(quoteStatesDate)) return 'uncorroborated';
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

const publishedDateSchema = z.strictObject({
  quote: z.string().trim().min(1),
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
  cycle_on_page: z.string().nullable(),
  evidence: z.string().nullable(),
  year_evidence: z.string().nullable(),
  time_zone_evidence: z.string().nullable(),
  time_zone: z.string().nullable(),
  eligibility_evidence: z.string().nullable(),
  preview: nullableWindowDate,
  resident_open: nullableWindowDate,
  general_open: nullableWindowDate,
  unclassified_open: nullableWindowDate,
  note: z.string().nullable(),
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
    cycle_on_page: { type: ['string', 'null'] },
    evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text of the section the dates were read from.',
    },
    year_evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text stating the YEAR of every complete date.',
    },
    time_zone_evidence: {
      type: ['string', 'null'],
      description: 'Verbatim page text naming the time zone or the place the program is in.',
    },
    time_zone: {
      type: ['string', 'null'],
      description: 'IANA time zone that time_zone_evidence establishes; null without it.',
    },
    eligibility_evidence: {
      type: ['string', 'null'],
      description: 'Which label the page attaches to each opening, with the quoted label.',
    },
    preview: { $ref: '#/$defs/publishedDate' },
    resident_open: { $ref: '#/$defs/publishedDate' },
    general_open: { $ref: '#/$defs/publishedDate' },
    unclassified_open: { $ref: '#/$defs/publishedDate' },
    note: {
      type: ['string', 'null'],
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
          description: 'The shortest verbatim page text stating this date and its time.',
        },
        date: {
          type: ['string', 'null'],
          description: 'YYYY-MM-DD, or null when the page does not establish the year or day',
        },
        time: {
          type: ['string', 'null'],
          description: '24-hour HH:MM, or null when the page publishes no time',
        },
      },
      required: ['quote', 'date', 'time'],
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
    slot?.date ? { quote: slot.quote, date: slot.date, time: slot.time } : null;
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
