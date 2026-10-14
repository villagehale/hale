import { fragment, readCourseModel } from '~/lib/channel/spots/availability';
import {
  type PrepInput,
  type UnreadableReason,
  isBookMe4ErrorPage,
  readCourseFacts,
} from './sequence/prepare';
import {
  type ExtractedWindow,
  MIN_VERIFY_CONFIDENCE,
  type PublishedDate,
  type UnfoundReason,
  corroborationFailure,
} from './verify-window';

/** Metadata from this fetch, not a stored window or the parent's display zone.
 * URL validation remains at the fetch boundary; these adapters perform no I/O. */
export interface RegistrationReadSource {
  sourceUrl: string;
  checkedAt: Date;
  timeZone: string | null;
}

export type RegistrationDateKind =
  | 'preview'
  | 'resident_open'
  | 'member_open'
  | 'general_open'
  | 'unclassified_open';

export interface LiveRegistrationDate extends PublishedDate {
  kind: RegistrationDateKind;
  evidence: readonly string[];
}

/** No date field exists on a failed/unverified read, so it cannot carry a DB fallback.
 * Keep local date/time separate: a date-only page does not publish a midnight instant. */
export type LiveRegistrationReading = RegistrationReadSource & {
  reader: 'ai' | 'perfectmind';
} & (
    | { status: 'verified'; dates: LiveRegistrationDate[] }
    | {
        status: 'unverified';
        reason:
          | UnfoundReason
          | 'no_dates_for_cycle'
          | 'low_confidence'
          | 'uncorroborated'
          | 'invalid_date'
          | 'unknown_time_zone'
          | 'eligibility_unverified';
      }
    | { status: 'unreadable'; reason: UnreadableReason | 'extract_failed' | 'read_budget' }
    | { status: 'gone'; evidence: readonly string[] }
  );

export type RegistrationExtractionInput =
  | { ok: true; extracted: ExtractedWindow; pageText: string }
  | { ok: false; reason: 'fetch_failed' | 'extract_failed' };

function validPublishedDate({ date, time }: PublishedDate): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return false;
  return time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

/** A real quote containing a real year is not proof of the model's month/day/hour. */
function publishedValueIsQuoted(value: PublishedDate, evidence: string): boolean {
  const [year, month, day] = value.date.split('-').map(Number);
  const months = [
    'jan(?:uary)?',
    'feb(?:ruary)?',
    'mar(?:ch)?',
    'apr(?:il)?',
    'may',
    'jun(?:e)?',
    'jul(?:y)?',
    'aug(?:ust)?',
    'sep(?:t(?:ember)?)?',
    'oct(?:ober)?',
    'nov(?:ember)?',
    'dec(?:ember)?',
  ];
  const monthName = months[month! - 1];
  if (!monthName) return false;
  const datePattern = new RegExp(
    `(?:${value.date}|\\b(?:${monthName})[.,]?\\s+0?${day}(?:st|nd|rd|th)?\\b|\\b0?${day}(?:st|nd|rd|th)?\\s+(?:${monthName})\\b|\\b0?${day}[/.-]0?${month}[/.-]${year}\\b|\\b0?${month}[/.-]0?${day}[/.-]${year}\\b)`,
    'ig',
  );
  const text = evidence.replace(/\s+/g, ' ');
  for (const match of text.matchAll(datePattern)) {
    if (value.time === null) return true;
    const following = text.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 60,
    );
    const clock = following.match(
      /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b|\b(noon|midnight)\b/i,
    );
    if (!clock) continue;
    // A neighbouring class/registration row's clock is not evidence for this date.
    if (
      new RegExp(
        `\\b(?:class(?:es)?|sessions?|preview|register|registration|resident|public|general|member)\\b|\\b(?:${months.join('|')})[.,]?\\s+\\d|\\b\\d{1,2}\\s+(?:${months.join('|')})\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
        'i',
      ).test(following.slice(0, clock.index))
    )
      continue;
    let hour: number;
    let minute = 0;
    if (clock[6]) hour = clock[6].toLowerCase() === 'noon' ? 12 : 0;
    else if (clock[4]) {
      hour = Number(clock[4]);
      minute = Number(clock[5]);
    } else {
      hour = (Number(clock[1]) % 12) + (/^p/i.test(clock[3] ?? '') ? 12 : 0);
      minute = Number(clock[2] ?? 0);
    }
    if (`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` === value.time)
      return true;
  }
  return false;
}

function verifiedReading(
  source: RegistrationReadSource,
  reader: LiveRegistrationReading['reader'],
  dates: LiveRegistrationDate[],
): LiveRegistrationReading {
  const base = { ...source, reader };
  if (dates.length === 0) return { ...base, status: 'unverified', reason: 'no_dates_for_cycle' };
  if (dates.some((date) => !validPublishedDate(date))) {
    return { ...base, status: 'unverified', reason: 'invalid_date' };
  }
  try {
    if (!source.timeZone) throw new Error('missing source time zone');
    new Intl.DateTimeFormat('en-US', { timeZone: source.timeZone });
  } catch {
    return { ...base, status: 'unverified', reason: 'unknown_time_zone' };
  }
  return { ...base, status: 'verified', dates };
}

/** Normalize the existing AI extractor's output after its page/year evidence gates.
 * Extraction still uses verify-registration-window; no new prompt or model route. */
export function normalizeExtractedRegistration(
  input: RegistrationExtractionInput,
  source: RegistrationReadSource,
): LiveRegistrationReading {
  const base = { ...source, reader: 'ai' as const };
  if (!input.ok) return { ...base, status: 'unreadable', reason: input.reason };
  const { extracted, pageText } = input;
  if (!extracted.found) {
    return { ...base, status: 'unverified', reason: extracted.reason ?? 'not_published' };
  }
  if (!Number.isFinite(extracted.confidence) || extracted.confidence < MIN_VERIFY_CONFIDENCE) {
    return { ...base, status: 'unverified', reason: 'low_confidence' };
  }
  const publishedDates = [extracted.preview, extracted.residentOpen, extracted.generalOpen].filter(
    (date): date is PublishedDate => date !== null,
  );
  if (publishedDates.some((date) => !validPublishedDate(date)))
    return { ...base, status: 'unverified', reason: 'invalid_date' };
  if (
    !extracted.evidence ||
    !extracted.yearEvidence ||
    corroborationFailure(pageText, extracted, source.checkedAt) !== null ||
    publishedDates.some((date) => !publishedValueIsQuoted(date, extracted.evidence ?? ''))
  ) {
    return { ...base, status: 'unverified', reason: 'uncorroborated' };
  }
  const dates: LiveRegistrationDate[] = [];
  for (const [kind, published] of [
    ['preview', extracted.preview],
    ['resident_open', extracted.residentOpen],
    ['general_open', extracted.generalOpen],
  ] as const) {
    if (published)
      dates.push({ kind, ...published, evidence: [extracted.evidence, extracted.yearEvidence] });
  }
  return verifiedReading(source, 'ai', dates);
}

/** Read only the registration clocks: no family-specific age/drift verdict and no
 * course start date masquerading as registration. Keep the existing model-ID check. */
export function readCourseRegistration(
  input: PrepInput,
  context: RegistrationReadSource & { courseId: string },
): LiveRegistrationReading {
  const { courseId, ...source } = context;
  const base = { ...source, reader: 'perfectmind' as const };
  if (!input.ok) return { ...base, status: 'unreadable', reason: input.reason };
  const read = readCourseModel(input.raw, courseId);
  if (!read.ok) {
    if (read.reason === 'no_model' && isBookMe4ErrorPage(input.raw)) {
      return { ...base, status: 'gone', evidence: ['<title>BookMe4 Error Page', 'was not found'] };
    }
    return { ...base, status: 'unreadable', reason: read.reason };
  }
  const { facts } = readCourseFacts(read.model, read.blob);
  const dates: LiveRegistrationDate[] = [];
  for (const [kind, key] of [
    ['resident_open', 'ResidentsRegistrationDateValue'],
    ['member_open', 'MembersRegistrationDateValue'],
    ['general_open', 'PublicRegistrationStartDateValue'],
  ] as const) {
    const value = facts[key];
    if (value == null) continue;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?$/.test(value)) {
      return { ...base, status: 'unverified', reason: 'invalid_date' };
    }
    const evidence = fragment(key, value);
    if (!read.blob.includes(evidence)) {
      return { ...base, status: 'unverified', reason: 'uncorroborated' };
    }
    dates.push({ kind, date: value.slice(0, 10), time: value.slice(11, 16), evidence: [evidence] });
  }
  if (dates.length === 0) return { ...base, status: 'unverified', reason: 'not_published' };
  return verifiedReading(source, 'perfectmind', dates);
}
