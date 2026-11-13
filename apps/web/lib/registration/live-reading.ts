import { fragment, readCourseModel } from '~/lib/channel/spots/availability';
import type { RegistrationPageFetch } from './page';
import type { RegistrationPdfRead, RegistrationPdfRefusal } from './pdf';
import { isBookMe4ErrorPage, readCourseFacts } from './sequence/prepare';
import {
  type AiDateKind,
  DATE_ONLY_WALL_CLOCK,
  type ExtractedWindow,
  MIN_VERIFY_CONFIDENCE,
  type PartialRegistrationDate,
  type UnfoundReason,
  corroborationFailure,
  normalizeQuote,
  pinYearByWeekday,
} from './verify-window';

/**
 * VIL-423 — what one live read of a registration page says, in a shape that cannot
 * carry a date it did not verify.
 *
 * Only the `verified` variant has `dates` and `timeZone`, so a failed, refused or
 * unproven read has no field a stored date could be copied into, and a verified read
 * without a zone the page (or the portal's own registry entry) states cannot be
 * expressed. Every other outcome is named.
 */

/** This read's own metadata — never a stored window, never the family's zone. */
export interface RegistrationReadSource {
  sourceUrl: string;
  checkedAt: Date;
}

export type RegistrationDateKind = AiDateKind | 'member_open';

export interface LiveRegistrationDate {
  kind: RegistrationDateKind;
  date: string;
  /** Null when the page prints no time: the anchor is then the start of that local day,
   * and a later composer must say the time is unknown rather than read one off it. */
  time: string | null;
  /** The page words this date stands on. */
  evidence: readonly string[];
  /** Set only where the page prints no year and the year was pinned by the printed
   * weekday (VIL-684): exactly one of this year and next fits that weekday. */
  yearFrom?: 'printed_weekday';
}

export type UnverifiedReadingReason =
  | UnfoundReason
  | 'no_reason_given'
  | 'no_dates_for_cycle'
  | 'low_confidence'
  | 'uncorroborated'
  | 'invalid_date'
  | 'unknown_time_zone'
  | 'incomplete_date';

/** The fetcher's own refusal or failure name: `non_public_host`, `http_status`, `timeout`… */
type PageFetchFailure = Extract<RegistrationPageFetch, { outcome: 'refused' | 'failed' }>['reason'];

export type UnreadableReadingReason =
  | PageFetchFailure
  | 'redirected'
  /** The page's server answered 5xx: its trouble, not the page's answer. */
  | 'http_server_error'
  /** The page came back with no words on it (a bot challenge served as a 200). */
  | 'empty_page'
  | 'extract_failed'
  | RegistrationPdfRefusal
  | 'pdf_reader_fault'
  | 'no_model'
  | 'bad_model'
  | 'wrong_course';

export type BusyReadingReason =
  | Extract<RegistrationPageFetch, { outcome: 'busy' }>['reason']
  | Extract<RegistrationPdfRead, { outcome: 'busy' }>['reason'];

type Reader = 'ai' | 'perfectmind';

export type VerifiedRegistrationReading = RegistrationReadSource & {
  reader: Reader;
  status: 'verified';
  timeZone: string;
  dates: LiveRegistrationDate[];
  partialDates: readonly PartialRegistrationDate[];
  /** The page's own name for the programs these dates are for (`Winter Session 2027 –
   * ten-week session`), only where those words are on the page. Absent otherwise, and
   * on a portal course read. */
  programOnPage?: string;
};

export type LiveRegistrationReading =
  | VerifiedRegistrationReading
  | (RegistrationReadSource & { reader: Reader } & (
        | {
            status: 'unverified';
            reason: UnverifiedReadingReason;
            partialDates: readonly PartialRegistrationDate[];
          }
        | { status: 'unreadable'; reason: UnreadableReadingReason }
        /** Hale is out of fetch or PDF capacity right now: retry later. Says nothing
         * about the page, so it is never an unreadable page and never a stored date. */
        | { status: 'busy'; reason: BusyReadingReason }
        | { status: 'gone' }
      ));

function validCalendarDate(date: string, time: string | null): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return false;
  return time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

/** The wall clock `timeZone` shows at `at`, read as if it were UTC (epoch ms). */
function wallClockAsUtc(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return Date.parse(
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00Z`,
  );
}

/**
 * The instant a local wall clock names in `timeZone`, or null when that zone skips the
 * clock (a DST gap). Two passes of "subtract the zone's offset at the current guess"
 * land on the right side of a transition whatever zone the server runs in; the round
 * trip must then show the same clock, or the clock does not exist.
 */
function wallClockInstant(date: string, time: string, timeZone: string): Date | null {
  const target = Date.parse(`${date}T${time}:00Z`);
  let at = target;
  for (let pass = 0; pass < 2; pass++) at = target - (wallClockAsUtc(at, timeZone) - at);
  return wallClockAsUtc(at, timeZone) === target ? new Date(at) : null;
}

/** The instant a verified date opens at. A date with no printed time anchors at the
 * start of that local day (DATE_ONLY_WALL_CLOCK). */
export function registrationAnchor(
  reading: VerifiedRegistrationReading,
  date: LiveRegistrationDate,
): Date {
  const at = wallClockInstant(date.date, date.time ?? DATE_ONLY_WALL_CLOCK, reading.timeZone);
  if (at === null) throw new Error('registration: the source zone skips this wall clock');
  return at;
}

function everyClockExists(dates: readonly LiveRegistrationDate[], timeZone: string): boolean {
  return dates.every(
    (date) => wallClockInstant(date.date, date.time ?? DATE_ONLY_WALL_CLOCK, timeZone) !== null,
  );
}

/** Canonical zone ids only. Offsets (`+05:00`), the fixed-offset legacy ids (`EST`,
 * `MST`), `Etc/` zones and aliases (`US/Eastern`) are not in it: a model that answers
 * `EST` for "Eastern" would put every summer date an hour off. */
const CANONICAL_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));
/** A zone quote must carry a word, so a lone letter or number that happens to be on the
 * page cannot select a zone. */
const LETTER_RUN = /\p{L}{3}/u;

/** The zone the page itself states: a quote that is on the page and carries a word,
 * naming a canonical zone. Anything else is no zone at all — never a guessed one. That
 * the quote names this zone is the model's reading. */
function quotedTimeZone(extracted: ExtractedWindow, pageText: string): string | null {
  const { timeZone, timeZoneEvidence } = extracted;
  if (timeZone === null || timeZoneEvidence === null) return null;
  if (!CANONICAL_TIME_ZONES.has(timeZone)) return null;
  const quote = normalizeQuote(timeZoneEvidence);
  if (!LETTER_RUN.test(quote) || !normalizeQuote(pageText).includes(quote)) return null;
  return timeZone;
}

/** Text as a run of lower-case words, an HTML entity the strip left behind read as a
 * gap: what a label is compared on, so `&ndash;` on the page meets `–` in the label. */
function wordRun(text: string): string {
  const words = text
    .replace(/&[a-z]+;/gi, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
  return words.length === 0 ? '' : ` ${words.join(' ')} `;
}

/** The model's name for the cycle, only where its words are on the page. */
function programOnPage(extracted: ExtractedWindow, pageText: string): { programOnPage?: string } {
  const label = extracted.cycleOnPage?.trim();
  if (!label) return {};
  const said = wordRun(label);
  return said !== '' && wordRun(pageText).includes(said) ? { programOnPage: label } : {};
}

/**
 * The AI reader's gate. The model's slot IS the eligibility verdict: code reads no
 * label, so an opening the model left unlabelled stays `unclassified_open`.
 */
export function normalizeExtractedRegistration(
  extracted: ExtractedWindow,
  pageText: string,
  source: RegistrationReadSource,
  /** Set only by the own-city lane (VIL-684): pin a yearless date's year by its printed
   * weekday, for this cycle (`pinYearByWeekday`). Every other reader reads no year a page
   * does not print. */
  yearFromWeekday?: { cycleLabel: string },
): LiveRegistrationReading {
  const base = { ...source, reader: 'ai' as const };
  const unverified = (
    reason: UnverifiedReadingReason,
    partialDates: readonly PartialRegistrationDate[] = [],
  ): LiveRegistrationReading => ({ ...base, status: 'unverified', reason, partialDates });

  if (!extracted.found) {
    return unverified(extracted.reason === null ? 'no_reason_given' : extracted.reason);
  }
  if (!(extracted.confidence >= MIN_VERIFY_CONFIDENCE)) return unverified('low_confidence');

  const slots = [
    ['preview', extracted.preview],
    ['resident_open', extracted.residentOpen],
    ['general_open', extracted.generalOpen],
    ['unclassified_open', extracted.unclassifiedOpen],
  ] as const;
  const published = slots.flatMap(([kind, date]) => (date ? [{ kind, ...date }] : []));
  if (published.some((date) => !validCalendarDate(date.date, date.time))) {
    return unverified('invalid_date');
  }
  if (corroborationFailure(pageText, extracted) !== null) return unverified('uncorroborated');
  const pinned = yearFromWeekday
    ? extracted.partialDates.flatMap((partial) => {
        const at = pinYearByWeekday(partial.quote, source.checkedAt, yearFromWeekday.cycleLabel);
        return at ? [{ ...partial, ...at }] : [];
      })
    : [];
  const partialDates = extracted.partialDates.filter(
    (partial) => !pinned.some((pin) => pin.kind === partial.kind && pin.quote === partial.quote),
  );
  if (published.length === 0 && pinned.length === 0) {
    return partialDates.length > 0
      ? unverified('incomplete_date', partialDates)
      : unverified('no_dates_for_cycle');
  }

  const timeZone = quotedTimeZone(extracted, pageText);
  if (timeZone === null) return unverified('unknown_time_zone', extracted.partialDates);

  const sectionEvidence = [extracted.evidence, extracted.yearEvidence].filter(
    (quote): quote is string => quote !== null,
  );
  const dates: LiveRegistrationDate[] = [
    ...published.map(({ kind, quote, date, time }) => ({
      kind,
      date,
      time,
      evidence: [quote, ...sectionEvidence],
    })),
    ...pinned.map(({ kind, quote, date, time }) => ({
      kind,
      date,
      time,
      evidence: [quote, ...sectionEvidence],
      yearFrom: 'printed_weekday' as const,
    })),
  ];
  if (!everyClockExists(dates, timeZone)) return unverified('invalid_date');
  return {
    ...base,
    status: 'verified',
    timeZone,
    dates,
    partialDates,
    ...programOnPage(extracted, pageText),
  };
}

const PORTAL_CLOCKS = [
  ['resident_open', 'ResidentsRegistrationDateValue'],
  ['member_open', 'MembersRegistrationDateValue'],
  ['general_open', 'PublicRegistrationStartDateValue'],
] as const;

/**
 * The PerfectMind reader: the course's own published clocks, read deterministically
 * from the vendor model in the bytes, in the portal's own zone. No family-specific
 * verdict, and no course start date standing in for a registration date.
 */
export function readCourseRegistration(
  raw: string,
  context: RegistrationReadSource & { courseId: string; portalTimeZone: string },
): LiveRegistrationReading {
  const { courseId, portalTimeZone, ...source } = context;
  const base = { ...source, reader: 'perfectmind' as const };
  const unverified = (reason: UnverifiedReadingReason): LiveRegistrationReading => ({
    ...base,
    status: 'unverified',
    reason,
    partialDates: [],
  });

  const read = readCourseModel(raw, courseId);
  if (!read.ok) {
    // The vendor's own not-found signature, never an inference from other page text.
    if (read.reason === 'no_model' && isBookMe4ErrorPage(raw)) return { ...base, status: 'gone' };
    return { ...base, status: 'unreadable', reason: read.reason };
  }
  const { facts } = readCourseFacts(read.model, read.blob);
  const dates: LiveRegistrationDate[] = [];
  for (const [kind, key] of PORTAL_CLOCKS) {
    const value = facts[key];
    if (value == null) continue;
    const date = value.slice(0, 10);
    const time = value.slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?$/.test(value) || !validCalendarDate(date, time)) {
      return unverified('invalid_date');
    }
    const evidence = fragment(key, value);
    if (!read.blob.includes(evidence)) return unverified('uncorroborated');
    dates.push({ kind, date, time, evidence: [evidence] });
  }
  if (dates.length === 0) return unverified('not_published');
  if (!everyClockExists(dates, portalTimeZone)) return unverified('invalid_date');
  return {
    ...base,
    status: 'verified',
    timeZone: portalTimeZone,
    dates,
    partialDates: [],
  };
}
