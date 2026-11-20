import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { ZodError, z } from 'zod';
import type { SpotState } from '~/lib/channel/spots/availability';
import { checkedSchedule } from '~/lib/channel/spots/schedule';
import { loadCronSkill } from '~/lib/cron/skill';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { MAX_PAGE_TEXT_CHARS, stripHtml } from './fetch';
import {
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
  registrationPageUrl,
} from './page';
import {
  DATE_ONLY_WALL_CLOCK,
  MIN_VERIFY_CONFIDENCE,
  REGISTRATION_TIME_ZONE,
  dateSpanRefusal,
  normalizeQuote,
} from './verify-window';

/**
 * VIL-337 · whether one class on ANY program page has room, read by the model and
 * checked by code against the page's own text.
 *
 * Built on VIL-423's live page reader: the bytes come only through the DNS-pinned,
 * never-redirecting fetcher {@link createLiveClassAvailabilityReader} constructs itself,
 * and every fact the model returns is a quote that must be on the page — the approach
 * `corroborationFailure` takes for dates. A count must also be printed inside its quote.
 *
 * Only `read` carries a state. A challenge page is `refused`, never a full class, and a
 * reading code cannot back is `unknown`: neither can satisfy the "was full" a transition
 * needs, so neither can send anything.
 */

export const CLASS_AVAILABILITY_SKILL = 'read-class-availability';
export const CLASS_AVAILABILITY_TOOL = 'class_availability';
export const CLASS_AVAILABILITY_TOOL_DESCRIPTION =
  'Return what this page says about the room in one session, quoting the page for every fact.';
export const CLASS_AVAILABILITY_MAX_TOKENS = 2048;

const QUOTE_MAX = 400;
const quote = { type: ['string', 'null'], maxLength: QUOTE_MAX } as const;

/** Property order is the order the model writes in: quotes before the verdicts. */
export const CLASS_AVAILABILITY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page_kind: { type: 'string', enum: ['program_page', 'challenge_page', 'other_page'] },
    session_quote: quote,
    sessions_matching: { type: 'string', enum: ['one', 'none', 'several'] },
    availability_quote: quote,
    waitlist_quote: quote,
    schedule_quote: quote,
    session_start_quote: quote,
    session_start_date_text: quote,
    session_start: { type: ['string', 'null'] },
    state: {
      type: 'string',
      enum: ['open', 'full', 'waitlist_full', 'registration_closed', 'not_yet_open', 'unknown'],
    },
    spots_left: { type: ['integer', 'null'], minimum: 0 },
    waitlist_room: { type: ['boolean', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'page_kind',
    'session_quote',
    'sessions_matching',
    'availability_quote',
    'waitlist_quote',
    'schedule_quote',
    'session_start_quote',
    'session_start_date_text',
    'session_start',
    'state',
    'spots_left',
    'waitlist_room',
    'confidence',
  ],
} as const;

const nullableQuote = z.string().max(QUOTE_MAX).nullable();
const extractionSchema = z.object({
  page_kind: z.enum(['program_page', 'challenge_page', 'other_page']),
  session_quote: nullableQuote,
  sessions_matching: z.enum(['one', 'none', 'several']),
  availability_quote: nullableQuote,
  waitlist_quote: nullableQuote,
  schedule_quote: nullableQuote,
  session_start_quote: nullableQuote,
  session_start_date_text: nullableQuote,
  session_start: z.string().max(10).nullable(),
  state: z.enum([
    'open',
    'full',
    'waitlist_full',
    'registration_closed',
    'not_yet_open',
    'unknown',
  ]),
  spots_left: z.number().int().nonnegative().nullable(),
  waitlist_room: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
});

export type ExtractedAvailability = z.infer<typeof extractionSchema>;

export function parseClassAvailability(raw: unknown): ExtractedAvailability {
  return extractionSchema.parse(raw);
}

/** How the model finds the session. Never the URL, never anything about the family. */
export interface ClassAvailabilityQuery {
  /** The parent's own words for the class, already through the label gate. */
  label: string;
  /** The page text that named the session when the watch was armed; null at arming. */
  anchor: string | null;
}

export function classAvailabilityInput(query: ClassAvailabilityQuery, pageText: string): string {
  return JSON.stringify({
    class_label: query.label,
    session_anchor: query.anchor,
    page_text: pageText,
  });
}

export type ClassAvailabilityUnknown =
  | 'not_a_program_page'
  | 'session_not_found'
  | 'several_sessions'
  | 'session_moved'
  | 'low_confidence'
  | 'not_stated'
  | 'uncorroborated'
  | 'unbacked_count'
  | 'extract_failed';

type PageFetchRefusal = Extract<RegistrationPageFetch, { outcome: 'refused' }>['reason'];

export type ClassAvailabilityReading =
  | {
      status: 'read';
      state: SpotState;
      /** The page text naming the session, which later reads must find again. */
      session: string;
      spotsLeft: number | null;
      waitlistRoom: boolean;
      schedule: string | null;
      /** First class, off the listing's own words, or null when the page does not
       * publish a start Hale can stand behind. The watch ends then. */
      sessionStartsAt: Date | null;
      digest: string;
    }
  | { status: 'not_registrable'; reason: 'closed' | 'not_yet_open'; digest: string }
  /** The page text is byte-for-byte what the caller last read: no model call was made. */
  | { status: 'unchanged'; digest: string }
  | { status: 'unknown'; reason: ClassAvailabilityUnknown }
  | { status: 'refused'; reason: 'challenge_page' | 'redirected' | PageFetchRefusal }
  | { status: 'failed'; reason: 'timeout' | 'network_error' }
  /** Hale's own fetch capacity, not the page: retry later. */
  | { status: 'busy'; reason: 'host_busy' };

export interface ClassAvailabilityTarget extends ClassAvailabilityQuery {
  sourceUrl: string;
  /** The digest of the last page text this watch read without trouble, or null. */
  lastDigest: string | null;
}

export type ClassAvailabilityReader = (
  target: ClassAvailabilityTarget,
) => Promise<ClassAvailabilityReading>;

export interface ClassAvailabilityPorts {
  fetchBody(url: string): Promise<RegistrationPageFetch>;
  extract(query: ClassAvailabilityQuery, pageText: string): Promise<ExtractedAvailability>;
}

/**
 * Bot-check vendors' own signatures in the raw bytes, asked before the model. A page
 * carrying one is the vendor's stand-in for the real page, so it says nothing about
 * the class.
 */
const CHALLENGE_SIGNATURES = [
  'challenges.cloudflare.com',
  '/cdn-cgi/challenge-platform/',
  'cf-browser-verification',
  '_Incapsula_Resource',
  'captcha-delivery.com',
  'px-captcha',
  'awswaf-captcha',
  'sec-if-cpt-container',
] as const;

export function isChallengePage(raw: string): boolean {
  return CHALLENGE_SIGNATURES.some((signature) => raw.includes(signature));
}

const LETTER_RUN = /\p{L}{3}/u;

function digitsIn(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number);
}

export function pageDigest(pageText: string): string {
  return createHash('sha256').update(pageText).digest('hex').slice(0, 32);
}

function calendarDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === date;
}

/** Years the page actually prints. A start whose year is not among them is a guess. */
function yearsOnPage(pageText: string): Set<string> {
  return new Set(normalizeQuote(pageText).match(/\b(19|20)\d{2}\b/g) ?? []);
}

/**
 * The first class, when the listing/provider page states it and the model's date is
 * the one its own quote prints. Null is the sixty-day bound, never a refused watch:
 * a page that is full today is still worth watching if it did not print a start.
 */
export function listingSessionStart(
  extracted: Pick<
    ExtractedAvailability,
    'session_start_quote' | 'session_start_date_text' | 'session_start'
  >,
  pageText: string,
): Date | null {
  const quote = extracted.session_start_quote;
  const dateText = extracted.session_start_date_text;
  const date = extracted.session_start;
  if (quote === null || dateText === null || date === null) return null;
  if (!calendarDay(date) || !yearsOnPage(pageText).has(date.slice(0, 4))) return null;
  const page = normalizeQuote(pageText);
  if (!page.includes(normalizeQuote(quote))) return null;
  if (dateSpanRefusal({ quote, dateText, timeText: null, date, time: null }) !== null) {
    return null;
  }
  try {
    return zonedLocalInstant(date, DATE_ONLY_WALL_CLOCK, REGISTRATION_TIME_ZONE);
  } catch {
    return null;
  }
}

/**
 * The gate. Every fact the model returned must be a quote on the page, a count must be
 * printed inside its own quote, and a session found again must be the one first armed.
 */
export function normalizeClassAvailability(
  extracted: ExtractedAvailability,
  pageText: string,
  query: ClassAvailabilityQuery,
): ClassAvailabilityReading {
  const unknown = (reason: ClassAvailabilityUnknown): ClassAvailabilityReading => ({
    status: 'unknown',
    reason,
  });
  const page = normalizeQuote(pageText);
  const onPage = (text: string | null): text is string =>
    text !== null && text.trim() !== '' && page.includes(normalizeQuote(text));

  if (extracted.page_kind === 'challenge_page')
    return { status: 'refused', reason: 'challenge_page' };
  if (extracted.page_kind === 'other_page') return unknown('not_a_program_page');
  if (extracted.sessions_matching === 'none') return unknown('session_not_found');
  if (extracted.sessions_matching === 'several') return unknown('several_sessions');
  if (!(extracted.confidence >= MIN_VERIFY_CONFIDENCE)) return unknown('low_confidence');
  if (extracted.state === 'unknown') return unknown('not_stated');

  const session = extracted.session_quote;
  if (!onPage(session)) return unknown('uncorroborated');
  if (query.anchor !== null && normalizeQuote(session) !== normalizeQuote(query.anchor)) {
    return unknown('session_moved');
  }
  const availability = extracted.availability_quote;
  if (!onPage(availability)) return unknown('uncorroborated');

  const digest = pageDigest(pageText);
  if (extracted.state === 'registration_closed') {
    return { status: 'not_registrable', reason: 'closed', digest };
  }
  if (extracted.state === 'not_yet_open') {
    return { status: 'not_registrable', reason: 'not_yet_open', digest };
  }

  const spotsLeft = extracted.spots_left;
  if (spotsLeft !== null && !digitsIn(normalizeQuote(availability)).includes(spotsLeft)) {
    return unknown('unbacked_count');
  }
  if (extracted.state === 'open' && spotsLeft === 0) return unknown('unbacked_count');
  if (extracted.state !== 'open' && spotsLeft !== null && spotsLeft > 0) {
    return unknown('unbacked_count');
  }

  const waitlistStated = extracted.waitlist_room !== null;
  if (waitlistStated && !onPage(extracted.waitlist_quote)) return unknown('uncorroborated');
  if (extracted.state === 'waitlist_full' && extracted.waitlist_room !== false) {
    return unknown('uncorroborated');
  }

  const scheduleQuote = extracted.schedule_quote;
  const schedule = onPage(scheduleQuote) ? checkedSchedule(scheduleQuote) : null;

  return {
    status: 'read',
    state: extracted.state,
    session,
    spotsLeft: extracted.state === 'open' ? spotsLeft : null,
    waitlistRoom: extracted.state === 'full' && extracted.waitlist_room === true,
    schedule,
    sessionStartsAt: listingSessionStart(extracted, pageText),
    digest,
  };
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof Anthropic.APIError ||
    error instanceof ZodError
  );
}

const PDF_MAGIC_SCAN_BYTES = 1024;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Outcome names and the host only — never the page, the path, the label or a quote. */
function logReading(target: ClassAvailabilityTarget, reading: ClassAvailabilityReading): void {
  console.info(
    {
      outcome: reading.status,
      reason: 'reason' in reading ? reading.reason : null,
      host: hostOf(target.sourceUrl),
      anchored: target.anchor !== null,
    },
    'class availability read',
  );
}

/** A reader whose byte cache lives as long as this reader: one sweep run or one turn. */
export function createClassAvailabilityReader(
  ports: ClassAvailabilityPorts,
): ClassAvailabilityReader {
  const bodies = new Map<string, Promise<RegistrationPageFetch>>();

  async function read(target: ClassAvailabilityTarget): Promise<ClassAvailabilityReading> {
    const check = registrationPageUrl(target.sourceUrl);
    if (check.outcome === 'refused') return { status: 'refused', reason: check.reason };
    const url = check.url;
    let pending = bodies.get(url);
    if (!pending) {
      pending = ports.fetchBody(url);
      bodies.set(url, pending);
    }
    const fetched = await pending;
    if (fetched.outcome === 'busy') return { status: 'busy', reason: fetched.reason };
    if (fetched.outcome === 'redirected') return { status: 'refused', reason: 'redirected' };
    if (fetched.outcome === 'failed') return { status: 'failed', reason: fetched.reason };
    if (fetched.outcome === 'refused') return { status: 'refused', reason: fetched.reason };

    if (Buffer.from(fetched.body.subarray(0, PDF_MAGIC_SCAN_BYTES)).includes('%PDF-')) {
      return { status: 'unknown', reason: 'not_a_program_page' };
    }
    const raw = fetched.body.toString('utf8');
    if (isChallengePage(raw)) return { status: 'refused', reason: 'challenge_page' };
    const pageText = stripHtml(raw).slice(0, MAX_PAGE_TEXT_CHARS);
    if (!LETTER_RUN.test(pageText)) return { status: 'unknown', reason: 'not_a_program_page' };

    const digest = pageDigest(pageText);
    if (target.lastDigest === digest) return { status: 'unchanged', digest };

    let extracted: ExtractedAvailability;
    try {
      extracted = await ports.extract({ label: target.label, anchor: target.anchor }, pageText);
    } catch (error) {
      if (isModelFailure(error)) return { status: 'unknown', reason: 'extract_failed' };
      throw error;
    }
    return normalizeClassAvailability(extracted, pageText, target);
  }

  return async (target) => {
    const reading = await read(target);
    logReading(target, reading);
    return reading;
  };
}

/**
 * The model's reading of one page. The skill is loaded outside any catch: a missing
 * skill file is a deploy bug, never "the page does not say".
 */
export async function extractClassAvailability(
  query: ClassAvailabilityQuery,
  pageText: string,
  client: AgentClient,
): Promise<ExtractedAvailability> {
  const skill = await loadCronSkill(CLASS_AVAILABILITY_SKILL);
  const { value } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: classAvailabilityInput(query, pageText),
    toolName: CLASS_AVAILABILITY_TOOL,
    toolDescription: CLASS_AVAILABILITY_TOOL_DESCRIPTION,
    inputJsonSchema: CLASS_AVAILABILITY_JSON_SCHEMA,
    schema: extractionSchema,
    maxTokens: CLASS_AVAILABILITY_MAX_TOKENS,
  });
  return value;
}

/** The one production reader. The fetch port is the DNS-pinned fetcher that never
 * follows a redirect, built here so no caller can hand in another. */
export function createLiveClassAvailabilityReader(
  client: AgentClient,
  timeoutMs?: number,
): ClassAvailabilityReader {
  return createClassAvailabilityReader({
    fetchBody: createRegistrationPageBytesFetch(timeoutMs),
    extract: (query, pageText) => extractClassAvailability(query, pageText, client),
  });
}
