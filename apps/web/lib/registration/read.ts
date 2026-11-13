import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import type { RegistrationWindow } from '@hale/db';
import { ZodError } from 'zod';
import { SPOT_PORTAL_HOSTS, sanitizeSpotUrl } from '~/lib/channel/spots/url';
import { StructuredOutputError } from '~/lib/pipeline/structured';
import { MAX_PAGE_TEXT_CHARS, stripHtml } from './fetch';
import {
  type BusyReadingReason,
  type LiveRegistrationDate,
  type LiveRegistrationReading,
  type RegistrationReadSource,
  type UnreadableReadingReason,
  type VerifiedRegistrationReading,
  normalizeExtractedRegistration,
  readCourseRegistration,
  registrationAnchor,
} from './live-reading';
import { resolveFamilyOpen } from './match-registration-windows';
import {
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
  registrationPageUrl,
} from './page';
import { type RegistrationPdfRead, registrationPdfText } from './pdf';
import {
  type CycleIdentity,
  type ExtractedWindow,
  type SeasonRegistrationWindow,
  extractPublishedWindow,
} from './verify-window';

/**
 * VIL-423 — read a registration page live, when a date is needed, and return only what
 * that read verified. No stored date is ever a fallback, and the caller cannot hand the
 * reader a time zone: it comes from the page, or from the portal's own registry entry.
 */

export type RegistrationTarget = CycleIdentity & { sourceUrl: string };

/** The seam tests drive. `fetchBody` is typed as the hardened fetcher's named outcomes,
 * but a shape is not a guard: production builds its reader only through
 * {@link createLiveRegistrationReader}, which constructs that fetcher itself. */
export interface RegistrationReaderPorts {
  fetchBody(url: string): Promise<RegistrationPageFetch>;
  extract(cycle: CycleIdentity, pageText: string): Promise<ExtractedWindow>;
}

export type RegistrationReader = (
  target: RegistrationTarget,
  now: Date,
) => Promise<LiveRegistrationReading>;

const PDF_MAGIC_SCAN_BYTES = 1024;

function isPdf(body: Uint8Array): boolean {
  return Buffer.from(body.subarray(0, PDF_MAGIC_SCAN_BYTES)).includes('%PDF-');
}

/** A model failure the reader names, as opposed to a deploy bug (a missing skill
 * file, a programming error) that must surface rather than read as "no date". */
function isModelFailure(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof Anthropic.APIError ||
    error instanceof ZodError
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** One line per read: ids and outcome names only — no page text, quote, cycle label,
 * path or query string. */
function logReading(target: RegistrationTarget, reading: LiveRegistrationReading): void {
  console.info(
    {
      outcome: reading.status,
      reason: 'reason' in reading ? reading.reason : null,
      reader: reading.reader,
      municipality: target.municipality,
      programDomain: target.programDomain,
      host: hostOf(target.sourceUrl),
    },
    'registration read',
  );
}

/** How a reader reads. `yearFromWeekday` is the own-city lane's (VIL-684): a yearless
 * date's year pinned by its printed weekday, inside the days the season being read
 * registers in as of the read (`pinYearByWeekday`). Absent for every other reader. */
export interface RegistrationReaderOptions {
  yearFromWeekday?: (now: Date) => SeasonRegistrationWindow;
}

/** A reader whose cache (bytes and PDF text by URL, readings by target) lives only as
 * long as this reader: one operation. A later send builds a new one. */
export function createRegistrationReader(
  ports: RegistrationReaderPorts,
  options: RegistrationReaderOptions = {},
): RegistrationReader {
  const bodies = new Map<string, Promise<RegistrationPageFetch>>();
  const pdfTexts = new Map<string, Promise<RegistrationPdfRead>>();
  const readings = new Map<string, Promise<LiveRegistrationReading>>();

  const cached = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    let pending = cache.get(key);
    if (!pending) {
      pending = load();
      cache.set(key, pending);
    }
    return pending;
  };

  async function read(target: RegistrationTarget, now: Date): Promise<LiveRegistrationReading> {
    const source: RegistrationReadSource = { sourceUrl: target.sourceUrl, checkedAt: now };
    const course = sanitizeSpotUrl(target.sourceUrl);
    const portal = course.ok ? SPOT_PORTAL_HOSTS[course.host] : undefined;
    const unreadable = (reason: UnreadableReadingReason): LiveRegistrationReading => ({
      ...source,
      reader: portal ? 'perfectmind' : 'ai',
      status: 'unreadable',
      reason,
    });
    const busy = (reason: BusyReadingReason): LiveRegistrationReading => ({
      ...source,
      reader: portal ? 'perfectmind' : 'ai',
      status: 'busy',
      reason,
    });

    const check = registrationPageUrl(target.sourceUrl);
    if (check.outcome === 'refused') return unreadable(check.reason);
    const url = check.url;

    const fetched = await cached(bodies, url, () => ports.fetchBody(url));
    if (fetched.outcome === 'busy') return busy(fetched.reason);
    if (fetched.outcome === 'redirected') return unreadable('redirected');
    // A 5xx is the server's trouble, not the page's answer: named apart from a refusal so
    // a caller can ask again instead of reading it as "this page says nothing".
    if (
      fetched.outcome === 'refused' &&
      fetched.reason === 'http_status' &&
      fetched.status >= 500
    ) {
      return unreadable('http_server_error');
    }
    if (fetched.outcome !== 'fetched') return unreadable(fetched.reason);
    const body = fetched.body;

    let pageText: string;
    if (isPdf(body)) {
      const pdf = await cached(pdfTexts, url, () => registrationPdfText(body));
      if (pdf.outcome === 'busy') return busy(pdf.reason);
      if (pdf.outcome === 'refused') return unreadable(pdf.reason);
      if (pdf.outcome === 'reader_fault') return unreadable('pdf_reader_fault');
      pageText = pdf.pageDerivedText;
    } else {
      const raw = Buffer.from(body).toString('utf8');
      if (course.ok && portal) {
        return readCourseRegistration(raw, {
          ...source,
          courseId: course.courseId,
          portalTimeZone: portal.timeZone,
        });
      }
      pageText = stripHtml(raw).slice(0, MAX_PAGE_TEXT_CHARS);
    }
    // A page with no words on it (a bot challenge served as a 200) says nothing, and a
    // model asked about it answers "not published": it is unreadable, and never asked.
    if (!/\p{L}/u.test(pageText)) return unreadable('empty_page');

    let extracted: ExtractedWindow;
    try {
      // Built field by field: neither the URL nor anything about a family reaches the model.
      extracted = await ports.extract(
        {
          municipality: target.municipality,
          programDomain: target.programDomain,
          cycleLabel: target.cycleLabel,
        },
        pageText,
      );
    } catch (error) {
      if (isModelFailure(error)) return unreadable('extract_failed');
      throw error;
    }
    return normalizeExtractedRegistration(
      extracted,
      pageText,
      source,
      options.yearFromWeekday?.(now),
    );
  }

  return (target, now) => {
    const key = JSON.stringify([
      target.municipality,
      target.programDomain,
      target.cycleLabel,
      target.sourceUrl,
    ]);
    return cached(readings, key, async () => {
      const reading = await read(target, now);
      logReading(target, reading);
      return reading;
    });
  };
}

/** The one production reader. The fetch port is the DNS-pinned fetcher that never
 * follows a redirect, built here so no caller can hand in another; the URL check inside
 * the reader is then never the only SSRF guard. The model client is the caller's. */
export function createLiveRegistrationReader(
  client: AgentClient,
  options?: RegistrationReaderOptions,
): RegistrationReader {
  return createRegistrationReader(
    {
      fetchBody: createRegistrationPageBytesFetch(),
      extract: (cycle, pageText) => extractPublishedWindow(cycle, pageText, { client }),
    },
    options,
  );
}

/** What a catalog window asks the reader. A district row names its district in the
 * cycle label, so the model reads that district's dates. */
export function windowReadTarget(
  window: Pick<
    RegistrationWindow,
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
  };
}

/** The date a family can act on: the resident opening only for a resident family, else
 * the general opening. Never an unclassified opening — an unlabelled date is not
 * evidence that anyone in particular may register on it. */
export function registrationDate(
  reading: LiveRegistrationReading,
  resident: boolean,
): LiveRegistrationDate | null {
  if (reading.status !== 'verified') return null;
  return (
    (resident ? reading.dates.find((date) => date.kind === 'resident_open') : undefined) ??
    reading.dates.find((date) => date.kind === 'general_open') ??
    null
  );
}

export type LiveRegistrationWindow = RegistrationWindow & {
  reading: VerifiedRegistrationReading;
};

/**
 * Catalog windows with every date replaced by a live reading, or dropped. Only the
 * window's source metadata goes into the reader. A resident-only date applies only to a
 * family `resolveFamilyOpen` places in that one town; the postal code stays in code.
 */
export async function readRegistrationWindows(
  windows: readonly RegistrationWindow[],
  reader: RegistrationReader,
  now: Date,
  postal: string | null,
): Promise<LiveRegistrationWindow[]> {
  const live: LiveRegistrationWindow[] = [];
  for (const window of windows) {
    const reading = await reader(windowReadTarget(window), now);
    if (reading.status !== 'verified') continue;
    const { isResidentWindow } = resolveFamilyOpen(window, postal);
    const resident = reading.dates.find((date) => date.kind === 'resident_open');
    const open = registrationDate(reading, false) ?? (isResidentWindow ? resident : undefined);
    if (!open) continue;
    const preview = reading.dates.find((date) => date.kind === 'preview');
    live.push({
      ...window,
      reading,
      openAt: registrationAnchor(reading, open),
      residentOpenAt: resident ? registrationAnchor(reading, resident) : null,
      previewAt: preview ? registrationAnchor(reading, preview) : null,
      residentPriorityDays: null,
      verifiedAt: now,
    });
  }
  return live;
}
