import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, forceToolJson, pickLane } from '@hale/agent';
import { ZodError, z } from 'zod';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { StructuredOutputError } from '~/lib/pipeline/structured';
import { MAX_PAGE_TEXT_CHARS, stripHtml } from '~/lib/registration/fetch';
import {
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
  registrationPageUrl,
} from '~/lib/registration/page';
import { registrationPdfText } from '~/lib/registration/pdf';
import { dateSpanRefusal, normalizeQuote } from '~/lib/registration/verify-window';
import { isWinterBreak } from './cycle';
import { onOfficialHost } from './host';

/**
 * VIL-685 · read one school year's winter break off a school's own calendar page, or off
 * the text of an email that school sent (`createTextBreakReader`).
 *
 * The model only READS; code decides whether the reading stands. A break stands when:
 *   - the page was served from the board's official host (`onOfficialHost`);
 *   - each day's quote is on the page, its span is in the quote, and the span states the
 *     day extracted (the registration reader's `dateSpanRefusal` grammar);
 *   - the year of each day is printed, in its own quote or in `year_evidence` on the page;
 *   - both days fall inside this school year's winter (`isWinterBreak`);
 *   - the break's own name, as printed, can ride a text as itself.
 * Anything short of that is a named outcome, never a guessed date. PA days are not asked
 * for and not read: the skill reads the winter break and nothing else.
 */

export const SCHOOL_BREAK_READ_SKILL = 'school-break-read';
export const SCHOOL_BREAK_READ_TOOL = 'school_winter_break';
export const SCHOOL_BREAK_READ_DESCRIPTION =
  'Return the winter break this school calendar page publishes for the named school year.';
export const SCHOOL_BREAK_READ_MAX_TOKENS = 1024;
/** A label longer than this is not a break's name a text can carry (nudge-decide's bound). */
const MAX_LABEL_CHARS = 40;

const LINE = 300;
const SPAN = 80;

const daySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    quote: {
      type: 'string',
      maxLength: LINE,
      description: 'The shortest verbatim page text stating this day.',
    },
    date_text: {
      type: 'string',
      maxLength: SPAN,
      description: 'The words of quote, copied exactly, that state the day.',
    },
    date: { type: 'string', maxLength: SPAN, description: 'YYYY-MM-DD' },
  },
  required: ['quote', 'date_text', 'date'],
} as const;

export const SCHOOL_BREAK_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    board_on_page: {
      type: ['string', 'null'],
      maxLength: LINE,
      description: 'Verbatim page text naming the school or board this calendar belongs to.',
    },
    name: {
      type: ['string', 'null'],
      maxLength: SPAN,
      description: 'The winter break as the page names it, copied exactly.',
    },
    year_evidence: {
      type: ['string', 'null'],
      maxLength: LINE,
      description: 'Verbatim page text stating the school year or the year of each day.',
    },
    first_day: daySchema,
    last_day: daySchema,
    found: { type: 'boolean' },
  },
  required: ['board_on_page', 'name', 'year_evidence', 'first_day', 'last_day', 'found'],
} as const;

const dayParse = z
  .object({ quote: z.string(), date_text: z.string(), date: z.string() })
  .nullable();

export const schoolBreakReadParse = z.object({
  board_on_page: z.string().nullable(),
  name: z.string().nullable(),
  year_evidence: z.string().nullable(),
  first_day: dayParse,
  last_day: dayParse,
  found: z.boolean(),
});

export type SchoolBreakExtraction = z.infer<typeof schoolBreakReadParse>;

/** The user message, field by field: the school year and the page. Nothing about a family. */
export function schoolBreakReadInput(schoolYear: string, pageText: string): string {
  return JSON.stringify({ school_year: schoolYear, page_text: pageText });
}

export interface BreakDay {
  date: string;
  quote: string;
}

export interface VerifiedBreakReading {
  name: string;
  firstDay: BreakDay;
  lastDay: BreakDay;
}

export type BreakPageReading =
  | ({ status: 'verified'; sourceUrl: string } & VerifiedBreakReading)
  /** The page answered and names no winter break for this school year. */
  | { status: 'not_published'; sourceUrl: string }
  /** The model named a break the page does not back, by which check. */
  | { status: 'unverified'; sourceUrl: string; reason: BreakRefusal }
  /** Not served from the board's official host: never fetched. */
  | { status: 'not_official'; sourceUrl: string }
  | { status: 'unreadable'; sourceUrl: string; reason: string }
  /** Hale-side and transient: retry later. Says nothing about the page. */
  | { status: 'busy'; sourceUrl: string; reason: string };

export type BreakRefusal =
  | 'quote_off_page'
  | 'day_mismatch'
  | 'year_unstated'
  | 'not_winter'
  | 'name_unusable';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function realDay(date: string): boolean {
  if (!ISO_DAY.test(date)) return false;
  const at = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date;
}

/** The break's name a text may carry as itself, or null. */
export function usableBreakName(name: string | null): string | null {
  if (name === null) return null;
  // A footnote mark printed after the name (`Winter Break*`) is not part of it.
  const trimmed = name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[*†‡]+$/u, '')
    .trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_CHARS) return null;
  if (trimmed.includes('?') || !isPrintableGsm7Basic(trimmed)) return null;
  return trimmed;
}

/**
 * Whether an extraction stands on this page. Pure: the eval and the reader run the same
 * check. Returns the verified break, `not_published`, or the refusal by name.
 */
export function checkBreakReading(
  extraction: SchoolBreakExtraction,
  pageText: string,
  schoolYear: string,
): VerifiedBreakReading | { refused: BreakRefusal } | 'not_published' {
  const { first_day: first, last_day: last } = extraction;
  if (!extraction.found || first === null || last === null) return 'not_published';
  const page = normalizeQuote(pageText);
  const onPage = (text: string | null) =>
    text !== null && text.trim() !== '' && page.includes(normalizeQuote(text));
  if (!onPage(first.quote) || !onPage(last.quote)) return { refused: 'quote_off_page' };
  for (const day of [first, last]) {
    if (!realDay(day.date)) return { refused: 'day_mismatch' };
    // The span must be in the quote and state exactly this day. Checked on the span
    // alone: a range quote ("December 21, 2026 to January 1, 2027") rightly prints both
    // days, so the other day in it is not a conflict.
    if (!normalizeQuote(day.quote).includes(normalizeQuote(day.date_text))) {
      return { refused: 'day_mismatch' };
    }
    const refusal = dateSpanRefusal({
      quote: day.date_text,
      dateText: day.date_text,
      timeText: null,
      date: day.date,
      time: null,
    });
    if (refusal !== null) return { refused: 'day_mismatch' };
    const year = day.date.slice(0, 4);
    const yearInQuote = day.quote.includes(year);
    const yearOnPage = onPage(extraction.year_evidence) && extraction.year_evidence?.includes(year);
    if (!yearInQuote && !yearOnPage) return { refused: 'year_unstated' };
  }
  if (!isWinterBreak(schoolYear, first.date, last.date)) return { refused: 'not_winter' };
  const name = usableBreakName(extraction.name);
  if (name === null || !onPage(name)) return { refused: 'name_unusable' };
  return {
    name,
    firstDay: { date: first.date, quote: first.quote },
    lastDay: { date: last.date, quote: last.quote },
  };
}

export interface BreakPageReaderPorts {
  fetchBody(url: string): Promise<RegistrationPageFetch>;
  extract(schoolYear: string, pageText: string): Promise<SchoolBreakExtraction>;
}

export type BreakPageReader = (input: {
  url: string;
  officialHost: string;
  schoolYear: string;
}) => Promise<BreakPageReading>;

const PDF_MAGIC_SCAN_BYTES = 1024;

function isPdf(body: Uint8Array): boolean {
  return Buffer.from(body.subarray(0, PDF_MAGIC_SCAN_BYTES)).includes('%PDF-');
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof StructuredOutputError ||
    error instanceof Anthropic.APIError ||
    error instanceof ZodError
  );
}

/** The page's text, or why there is none. Board calendars are often PDFs. */
async function pageTextOf(
  body: Buffer,
): Promise<{ text: string } | { busy: string } | { unreadable: string }> {
  if (!isPdf(body)) {
    return { text: stripHtml(Buffer.from(body).toString('utf8')).slice(0, MAX_PAGE_TEXT_CHARS) };
  }
  const pdf = await registrationPdfText(body);
  if (pdf.outcome === 'read') return { text: pdf.pageDerivedText };
  if (pdf.outcome === 'busy') return { busy: pdf.reason };
  if (pdf.outcome === 'refused') return { unreadable: pdf.reason };
  return { unreadable: 'pdf_reader_fault' };
}

export function createBreakPageReader(ports: BreakPageReaderPorts): BreakPageReader {
  return async ({ url, officialHost, schoolYear }) => {
    const check = registrationPageUrl(url);
    if (check.outcome === 'refused') {
      return { status: 'unreadable', sourceUrl: url, reason: check.reason };
    }
    const sourceUrl = check.url;
    // Before the fetch: a page off the board's own host is never read at all.
    if (!onOfficialHost(sourceUrl, officialHost)) return { status: 'not_official', sourceUrl };
    const fetched = await ports.fetchBody(sourceUrl);
    if (fetched.outcome === 'busy') return { status: 'busy', sourceUrl, reason: fetched.reason };
    if (fetched.outcome === 'redirected') {
      return { status: 'unreadable', sourceUrl, reason: 'redirected' };
    }
    if (fetched.outcome !== 'fetched') {
      return { status: 'unreadable', sourceUrl, reason: fetched.reason };
    }
    const text = await pageTextOf(fetched.body);
    if ('busy' in text) return { status: 'busy', sourceUrl, reason: text.busy };
    if ('unreadable' in text) return { status: 'unreadable', sourceUrl, reason: text.unreadable };

    let extraction: SchoolBreakExtraction;
    try {
      extraction = await ports.extract(schoolYear, text.text);
    } catch (error) {
      if (isModelFailure(error))
        return { status: 'unreadable', sourceUrl, reason: 'extract_failed' };
      throw error;
    }
    const checked = checkBreakReading(extraction, text.text, schoolYear);
    if (checked === 'not_published') return { status: 'not_published', sourceUrl };
    if ('refused' in checked) return { status: 'unverified', sourceUrl, reason: checked.refused };
    return { status: 'verified', sourceUrl, ...checked };
  };
}

export type TextBreakReading =
  | ({ status: 'verified' } & VerifiedBreakReading)
  | { status: 'not_published' }
  | { status: 'unverified'; reason: BreakRefusal }
  | { status: 'unreadable'; reason: 'extract_failed' };

/** Reads the break off a school email's own text: the same model reading and the same
 * code check as a page, so every day stands on the email's words. */
export type TextBreakReader = (input: {
  text: string;
  schoolYear: string;
}) => Promise<TextBreakReading>;

export function createTextBreakReader(extract: BreakPageReaderPorts['extract']): TextBreakReader {
  return async ({ text, schoolYear }) => {
    const bounded = text.slice(0, MAX_PAGE_TEXT_CHARS);
    let extraction: SchoolBreakExtraction;
    try {
      extraction = await extract(schoolYear, bounded);
    } catch (error) {
      if (isModelFailure(error)) return { status: 'unreadable', reason: 'extract_failed' };
      throw error;
    }
    const checked = checkBreakReading(extraction, bounded, schoolYear);
    if (checked === 'not_published') return { status: 'not_published' };
    if ('refused' in checked) return { status: 'unverified', reason: checked.refused };
    return { status: 'verified', ...checked };
  };
}

/** One extraction call. The skill loads outside any catch: a missing skill is a deploy
 * bug, never "this board publishes nothing". */
export async function extractSchoolBreak(
  client: AgentClient,
  schoolYear: string,
  pageText: string,
): Promise<SchoolBreakExtraction> {
  const skill = await loadCronSkill(SCHOOL_BREAK_READ_SKILL);
  const { value } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: schoolBreakReadInput(schoolYear, pageText),
    toolName: SCHOOL_BREAK_READ_TOOL,
    toolDescription: SCHOOL_BREAK_READ_DESCRIPTION,
    inputJsonSchema: SCHOOL_BREAK_READ_SCHEMA,
    schema: schoolBreakReadParse,
    maxTokens: SCHOOL_BREAK_READ_MAX_TOKENS,
  });
  return value;
}

export function createLiveTextBreakReader(client: AgentClient): TextBreakReader {
  return createTextBreakReader((schoolYear, text) => extractSchoolBreak(client, schoolYear, text));
}

/** The one production reader: the DNS-pinned fetcher that never follows a redirect. */
export function createLiveBreakPageReader(client: AgentClient): BreakPageReader {
  return createBreakPageReader({
    fetchBody: createRegistrationPageBytesFetch(),
    extract: (schoolYear, pageText) => extractSchoolBreak(client, schoolYear, pageText),
  });
}
