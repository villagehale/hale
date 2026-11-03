import { fragment, readCourseModel } from '~/lib/channel/spots/availability';
import { zonedLocalInstant } from '~/lib/plan/spine';
import type { RegistrationPdfRefusal } from './pdf';
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
}

export type UnverifiedReadingReason =
  | UnfoundReason
  | 'no_dates_for_cycle'
  | 'low_confidence'
  | 'uncorroborated'
  | 'invalid_date'
  | 'unknown_time_zone'
  | 'incomplete_date';

export type UnreadableReadingReason =
  | 'unsafe_url'
  | 'redirected'
  | 'fetch_failed'
  | 'extract_failed'
  | RegistrationPdfRefusal
  | 'pdf_reader_fault'
  | 'no_model'
  | 'bad_model'
  | 'wrong_course';

type Reader = 'ai' | 'perfectmind';

export type VerifiedRegistrationReading = RegistrationReadSource & {
  reader: Reader;
  status: 'verified';
  timeZone: string;
  dates: LiveRegistrationDate[];
  partialDates: readonly PartialRegistrationDate[];
  note: string | null;
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
        | { status: 'gone' }
      ));

function validCalendarDate(date: string, time: string | null): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return false;
  return time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

/** The instant a local wall clock names in `timeZone`, or null when that zone skips the
 * clock (a DST gap): the round trip through the zone must land on the same clock. */
function wallClockInstant(date: string, time: string, timeZone: string): Date | null {
  const at = zonedLocalInstant(date, time, timeZone);
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
  const landed = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  return landed === `${date} ${time}` ? at : null;
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

/** The zone the page itself states: a quote that is on the page, naming a real IANA
 * zone. Anything else is no zone at all — never a guessed one. */
function quotedTimeZone(extracted: ExtractedWindow, pageText: string): string | null {
  const { timeZone, timeZoneEvidence } = extracted;
  if (!timeZone || !timeZoneEvidence?.trim()) return null;
  if (!normalizeQuote(pageText).includes(normalizeQuote(timeZoneEvidence))) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return timeZone;
}

/**
 * The AI reader's gate. The model's slot IS the eligibility verdict: code reads no
 * label, so an opening the model left unlabelled stays `unclassified_open`.
 */
export function normalizeExtractedRegistration(
  extracted: ExtractedWindow,
  pageText: string,
  source: RegistrationReadSource,
): LiveRegistrationReading {
  const base = { ...source, reader: 'ai' as const };
  const unverified = (
    reason: UnverifiedReadingReason,
    partialDates: readonly PartialRegistrationDate[] = [],
  ): LiveRegistrationReading => ({ ...base, status: 'unverified', reason, partialDates });

  if (!extracted.found) return unverified(extracted.reason ?? 'not_published');
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
  if (published.length === 0) {
    return extracted.partialDates.length > 0
      ? unverified('incomplete_date', extracted.partialDates)
      : unverified('no_dates_for_cycle');
  }

  const timeZone = quotedTimeZone(extracted, pageText);
  if (timeZone === null) return unverified('unknown_time_zone', extracted.partialDates);

  const sectionEvidence = [extracted.evidence, extracted.yearEvidence].filter(
    (quote): quote is string => quote !== null,
  );
  const dates = published.map(({ kind, quote, date, time }) => ({
    kind,
    date,
    time,
    evidence: [quote, ...sectionEvidence],
  }));
  if (!everyClockExists(dates, timeZone)) return unverified('invalid_date');
  return {
    ...base,
    status: 'verified',
    timeZone,
    dates,
    partialDates: extracted.partialDates,
    note: extracted.note,
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
    note: null,
  };
}
