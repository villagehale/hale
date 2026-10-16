import type { RegistrationSourceState } from '@hale/db';
import { SPOT_PORTAL_HOSTS, portalForMunicipality, sanitizeSpotUrl } from '~/lib/channel/spots/url';
import { pipelineClient } from '~/lib/pipeline/client';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { dayKeyIn } from '~/lib/plan/spine';
import { MAX_PAGE_TEXT_CHARS, stripHtml } from './fetch';
import {
  type LiveRegistrationDate,
  type LiveRegistrationReading,
  normalizeExtractedRegistration,
  readCourseRegistration,
} from './live-reading';
import { resolveMunicipalities } from './match-registration-windows';
import { createRegistrationPageBytesFetch, registrationPageUrl } from './page';
import { RegistrationPdfError, registrationPdfText } from './pdf';
import { type CycleIdentity, type ExtractedWindow, extractPublishedWindow } from './verify-window';

export interface RegistrationTarget extends CycleIdentity {
  sourceUrl: string;
  timeZone: string | null;
  residentTiers?: boolean;
}
export type RegistrationReader = (
  target: RegistrationTarget,
  now: Date,
) => Promise<LiveRegistrationReading>;

/** Cache only inside one operation. A send uses a new reader, never a stored result. */
export function createRegistrationReader(
  ports: {
    fetchBody: (url: string) => Promise<string | Uint8Array>;
    extract: (target: CycleIdentity, text: string) => Promise<ExtractedWindow>;
  } = {
    fetchBody: createRegistrationPageBytesFetch(),
    extract: (target, text) => extractPublishedWindow(target, text, { client: pipelineClient() }),
  },
): RegistrationReader {
  const pages = new Map<string, Promise<string | Uint8Array>>();
  const pdfTexts = new Map<string, Promise<string>>();
  const readings = new Map<string, Promise<LiveRegistrationReading>>();
  let started: number | null = null;
  return (target, now) => {
    const key = JSON.stringify(target);
    const existing = readings.get(key);
    if (existing) return existing;
    const read = (async (): Promise<LiveRegistrationReading> => {
      started ??= Date.now();
      const source = { sourceUrl: target.sourceUrl, timeZone: target.timeZone, checkedAt: now };
      if (readings.size >= 24 || Date.now() - started > 120_000) {
        return { ...source, reader: 'ai', status: 'unreadable', reason: 'read_budget' };
      }
      let body: string | Uint8Array;
      try {
        registrationPageUrl(target.sourceUrl);
        let pending = pages.get(target.sourceUrl);
        if (!pending) {
          pending = ports.fetchBody(target.sourceUrl);
          pages.set(target.sourceUrl, pending);
        }
        body = await pending;
      } catch {
        return { ...source, reader: 'ai', status: 'unreadable', reason: 'fetch_failed' };
      }
      try {
        let pageText: string;
        if (typeof body !== 'string' && Buffer.from(body.subarray(0, 1024)).includes('%PDF-')) {
          let text = pdfTexts.get(target.sourceUrl);
          if (!text) {
            text = registrationPdfText(body);
            pdfTexts.set(target.sourceUrl, text);
          }
          pageText = await text;
        } else {
          const raw = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
          if (raw.startsWith('%PDF-')) throw new RegistrationPdfError('pdf_unreadable');
          const course = sanitizeSpotUrl(target.sourceUrl);
          if (course.ok) {
            return validateReadingClock(
              readCourseRegistration(
                { ok: true, raw },
                {
                  ...source,
                  courseId: course.courseId,
                  timeZone: SPOT_PORTAL_HOSTS[course.host]!.timeZone,
                },
              ),
            );
          }
          pageText = stripHtml(raw).slice(0, MAX_PAGE_TEXT_CHARS);
        }
        const extracted = await ports.extract(
          { ...target, referenceDate: now.toISOString().slice(0, 10) },
          pageText,
        );
        const quote = extracted.timeZoneEvidence;
        const timeZone =
          target.timeZone ??
          (quote && pageText.includes(quote) ? (extracted.timeZone ?? null) : null);
        return validateReadingClock(
          normalizeExtractedRegistration(
            { ok: true, extracted, pageText },
            { ...source, timeZone },
          ),
        );
      } catch (error) {
        return {
          ...source,
          reader: 'ai',
          status: 'unreadable',
          reason: error instanceof RegistrationPdfError ? error.reason : 'extract_failed',
        };
      }
    })();
    readings.set(key, read);
    return read;
  };
}

function validateReadingClock(reading: LiveRegistrationReading): LiveRegistrationReading {
  if (reading.status !== 'verified') return reading;
  try {
    for (const date of reading.dates) registrationAnchor(reading, date);
  } catch {
    return {
      sourceUrl: reading.sourceUrl,
      checkedAt: reading.checkedAt,
      timeZone: reading.timeZone,
      reader: reading.reader,
      status: 'unverified',
      reason: 'invalid_date',
    };
  }
  return reading;
}

export function windowReadTarget(
  window: Pick<
    RegistrationSourceState,
    'municipality' | 'programDomain' | 'cycleLabel' | 'sourceUrl' | 'district'
  >,
): RegistrationTarget {
  return {
    municipality: window.municipality,
    programDomain: window.programDomain,
    cycleLabel: window.district
      ? `${window.cycleLabel} (${window.district.replaceAll('_', ' ')})`
      : window.cycleLabel,
    sourceUrl: window.sourceUrl,
    timeZone: 'America/Toronto',
    residentTiers: portalForMunicipality(window.municipality) !== null,
  };
}

export function registrationDate(
  reading: LiveRegistrationReading,
  resident: boolean,
): LiveRegistrationDate | null {
  if (reading.status !== 'verified') return null;
  return (
    (resident ? reading.dates.find((date) => date.kind === 'resident_open') : null) ??
    reading.dates.find((date) => date.kind === 'general_open') ??
    null
  );
}

/** A corroborated page fact, never an eligible date for scheduling a reminder. */
export function unclassifiedRegistrationDate(
  reading: LiveRegistrationReading,
): LiveRegistrationDate | null {
  return reading.status === 'verified'
    ? (reading.dates.find((date) => date.kind === 'unclassified_open') ?? null)
    : null;
}

/** Date-only anchors are scheduling markers, not a published midnight opening. */
export function registrationAnchor(
  reading: LiveRegistrationReading,
  date: LiveRegistrationDate,
): Date {
  if (!reading.timeZone) throw new Error('registration: missing source zone');
  const at = zonedLocalInstant(date.date, date.time ?? '12:00', reading.timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: reading.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)?.value;
  if (
    `${part('year')}-${part('month')}-${part('day')}` !== date.date ||
    `${part('hour')}:${part('minute')}` !== (date.time ?? '12:00')
  ) {
    throw new Error('registration: nonexistent source wall clock');
  }
  return at;
}

export function registrationWhen(
  reading: LiveRegistrationReading,
  date: LiveRegistrationDate,
): string {
  return `${date.date}${date.time === null ? ' (opening time not published)' : ` at ${date.time}`} ${reading.timeZone}`;
}

/** Protect published values, not the formatter's English connecting words. */
export function registrationDateRetained(
  message: string,
  date: LiveRegistrationDate | null,
  timeZone: string | null,
): boolean {
  return (
    !date ||
    (message.includes(date.date) &&
      (date.time === null || message.includes(date.time)) &&
      timeZone !== null &&
      message.includes(timeZone))
  );
}

export function registrationHasOpened(
  reading: LiveRegistrationReading,
  date: LiveRegistrationDate,
  now: Date,
): boolean {
  return date.time === null
    ? date.date < dayKeyIn(now, reading.timeZone!)
    : registrationAnchor(reading, date) <= now;
}

export type LiveRegistrationWindow = RegistrationSourceState & { reading: LiveRegistrationReading };

/** Only source metadata goes into the reader. No stored date is a fallback. */
export async function readRegistrationWindows(
  windows: readonly RegistrationSourceState[],
  reader: RegistrationReader,
  now: Date,
  postal: string | null = null,
): Promise<LiveRegistrationWindow[]> {
  const live: LiveRegistrationWindow[] = [];
  const municipalities = postal ? resolveMunicipalities(postal) : [];
  for (const window of windows) {
    const reading = await reader(windowReadTarget(window), now);
    if (reading.status !== 'verified') continue;
    const general = reading.dates.find((date) => date.kind === 'general_open');
    const resident = reading.dates.find((date) => date.kind === 'resident_open');
    // A resident-only date is usable only for a positively identified resident family.
    const applicable =
      general ??
      (municipalities.length === 1 && municipalities[0] === window.municipality ? resident : null);
    if (!applicable) continue;
    const preview = reading.dates.find((date) => date.kind === 'preview');
    live.push({
      ...window,
      reading,
      openAt: registrationAnchor(reading, applicable),
      residentOpenAt: resident ? registrationAnchor(reading, resident) : null,
      previewAt: preview ? registrationAnchor(reading, preview) : null,
      residentPriorityDays: null,
      verifiedAt: now,
    });
  }
  return live;
}
