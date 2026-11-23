import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { turnRemainingMs } from '~/lib/channel/router/deadline';
import { COURSE_PAGE_PATH } from '~/lib/channel/spots/url';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { MAX_PAGE_TEXT_CHARS, stripHtml } from '~/lib/registration/fetch';
import {
  type RegistrationPageFetch,
  createRegistrationPageBytesFetch,
  registrationPageUrl,
} from '~/lib/registration/page';
import { BIND_FETCH_TIMEOUT_MS, type PrepChild } from '~/lib/registration/sequence/prepare';
import {
  type ProgramTerms,
  type TermsRates,
  type TermsTax,
  keepPageQuote,
  readCourseTerms,
} from './evaluate';
import { moneyCentsWritten } from './money';
import { MAX_PAGE_QUOTE_CHARS } from './page-words';
import type { SignupTermsShown } from './types';

/**
 * VIL-715 · reads a program's page before Hale asks. A BookMe4 course page answers from
 * its own model. Whatever that leaves unanswered (always the refund policy, and everything
 * on any other page) is one model read in which every fact is a quote code finds on the
 * page. A failed read leaves the field unread, never guessed. The model sees page text
 * only: the child's date of birth stays in code.
 */
export const SIGNUP_PREFLIGHT_READ_SKILL = 'signup-preflight-read';
export const SIGNUP_PREFLIGHT_READ_TOOL = 'signup_preflight_read';
export const SIGNUP_PREFLIGHT_READ_TOOL_DESCRIPTION =
  'Return what this registration page says about its refund policy, prerequisites, ages and fees, quoting the page for every fact.';
export const SIGNUP_PREFLIGHT_READ_MAX_TOKENS = 1500;
/** With less of the turn than this left, the page's text is not read: those fields stay unread. */
export const PREFLIGHT_READ_MIN_TURN_MS = 20_000;

const QUOTE_MAX = MAX_PAGE_QUOTE_CHARS;
const quote = { type: ['string', 'null'], maxLength: QUOTE_MAX } as const;

/** Property order is the order the model writes in: quotes before verdicts. */
export const SIGNUP_PREFLIGHT_READ_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refund_quote: quote,
    prerequisite_quote: quote,
    prerequisite: { type: 'string', enum: ['required', 'none_stated'] },
    age_band_quote: quote,
    prices: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: { type: 'string', maxLength: QUOTE_MAX },
          rate: { type: 'string', enum: ['resident', 'non_resident', 'flat'] },
          cents: { type: 'integer', minimum: 0 },
        },
        required: ['quote', 'rate', 'cents'],
      },
    },
    tax_quote: quote,
    tax: { type: 'string', enum: ['included', 'plus_tax', 'unknown'] },
    currency_quote: quote,
    currency: { type: ['string', 'null'], enum: ['cad', 'usd', null] },
  },
  required: [
    'refund_quote',
    'prerequisite_quote',
    'prerequisite',
    'age_band_quote',
    'prices',
    'tax_quote',
    'tax',
    'currency_quote',
    'currency',
  ],
} as const;

const nullableQuote = z.string().max(QUOTE_MAX).nullable();
export const signupPreflightReadSchema = z
  .object({
    refund_quote: nullableQuote,
    prerequisite_quote: nullableQuote,
    prerequisite: z.enum(['required', 'none_stated']),
    age_band_quote: nullableQuote,
    prices: z
      .array(
        z
          .object({
            quote: z.string().max(QUOTE_MAX),
            rate: z.enum(['resident', 'non_resident', 'flat']),
            cents: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(6),
    tax_quote: nullableQuote,
    tax: z.enum(['included', 'plus_tax', 'unknown']),
    currency_quote: nullableQuote,
    currency: z.enum(['cad', 'usd']).nullable(),
  })
  .strict();

export type SignupPreflightRead = z.infer<typeof signupPreflightReadSchema>;

export interface PreflightReader {
  read(pageText: string): Promise<SignupPreflightRead | null>;
}

export function createPreflightReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): PreflightReader {
  return {
    async read(pageText) {
      const resolved = await client();
      if (!resolved) {
        console.info({ reason: 'client_unavailable' }, 'signup preflight read: unread');
        return null;
      }
      const skill = await loadCronSkill(SIGNUP_PREFLIGHT_READ_SKILL);
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: JSON.stringify({ page_text: pageText }),
          toolName: SIGNUP_PREFLIGHT_READ_TOOL,
          toolDescription: SIGNUP_PREFLIGHT_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_PREFLIGHT_READ_JSON_SCHEMA,
          schema: signupPreflightReadSchema,
          maxTokens: SIGNUP_PREFLIGHT_READ_MAX_TOKENS,
        });
        return value;
      } catch (err) {
        console.info(
          {
            reason: 'model_failed',
            detail: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'signup preflight read: unread',
        );
        return null;
      }
    },
  };
}

function ratesFromRead(read: SignupPreflightRead, pageText: string): TermsRates {
  const readCents = new Set(read.prices.map((row) => row.cents));
  // A $0 row stands only on a page that prints no amount the read left out: "$0 due today"
  // can sit beside the balance owed.
  const pageHasNoOtherPrice = moneyCentsWritten(pageText).every(
    (cents) => cents === 0 || readCents.has(cents),
  );
  const kept = read.prices.filter((row) => {
    if (keepPageQuote(row.quote, pageText) === null) return false;
    const written = moneyCentsWritten(row.quote);
    return row.cents === 0
      ? pageHasNoOtherPrice && written.every((cents) => cents === 0)
      : written.includes(row.cents);
  });
  // Every row the model named has to hold, or the price table is one Hale did not read.
  if (kept.length !== read.prices.length || kept.length === 0) return [];
  const [first] = kept;
  if (kept.length === 1 && first) return [{ rate: 'flat', cents: first.cents }];
  const resident = kept.filter((row) => row.rate === 'resident');
  const nonResident = kept.filter((row) => row.rate === 'non_resident');
  const [own] = resident;
  const [other] = nonResident;
  if (kept.length === 2 && resident.length === 1 && nonResident.length === 1 && own && other) {
    return [
      { rate: 'resident', cents: own.cents },
      { rate: 'non_resident', cents: other.cents },
    ];
  }
  return [];
}

function taxFromRead(read: SignupPreflightRead, pageText: string): TermsTax {
  if (read.tax === 'unknown') return 'unknown';
  return keepPageQuote(read.tax_quote, pageText) === null ? 'unknown' : read.tax;
}

/** The read's facts laid over what the page's model already said. A course model wins. */
export function applyPreflightRead(
  base: ProgramTerms,
  read: SignupPreflightRead,
  pageText: string,
): ProgramTerms {
  const refund = keepPageQuote(read.refund_quote, pageText);
  const prerequisiteQuote = keepPageQuote(read.prerequisite_quote, pageText);
  const stated = read.currency !== null && keepPageQuote(read.currency_quote, pageText) !== null;
  const currency = stated ? read.currency : base.currency;
  if (base.read === 'course_model') {
    return {
      ...base,
      refund: refund === null ? null : { quote: refund },
      currency,
      prerequisite:
        base.prerequisite.required === 'yes'
          ? { required: 'yes', quote: prerequisiteQuote }
          : base.prerequisite,
    };
  }
  return {
    ...base,
    read: 'page_text',
    refund: refund === null ? null : { quote: refund },
    currency,
    // A page that names no prerequisite has not said there is none.
    prerequisite:
      read.prerequisite === 'required' && prerequisiteQuote !== null
        ? { required: 'yes', quote: prerequisiteQuote }
        : { required: 'unknown', quote: null },
    age: { ...base.age, band: keepPageQuote(read.age_band_quote, pageText) },
    rates: ratesFromRead(read, pageText),
    tax: taxFromRead(read, pageText),
  };
}

const UNREAD: ProgramTerms = {
  read: 'unread',
  program: { courseIds: [], name: null },
  age: { fit: 'unknown', band: null, rule: null },
  prerequisite: { required: 'unknown', quote: null },
  refund: null,
  currency: null,
  rates: [],
  tax: 'unknown',
  pageOpensAt: null,
};

export interface ProgramTermsDeps {
  /** Undefined uses the DNS-pinned fetcher that never follows a redirect. */
  fetchBody?: (url: string) => Promise<RegistrationPageFetch>;
  /** Undefined uses the reply model. */
  preflightReader?: PreflightReader;
}

function courseIdOf(url: string): string | null {
  const parsed = new URL(url);
  if (!COURSE_PAGE_PATH.test(parsed.pathname)) return null;
  return parsed.searchParams.get('courseId');
}

export async function readProgramTerms(
  input: {
    registrationUrl: string;
    child: PrepChild;
    now: Date;
    timeZone: string;
    residency: SignupTermsShown['residency'];
  },
  deps: { fetchBody: (url: string) => Promise<RegistrationPageFetch>; reader: PreflightReader },
): Promise<ProgramTerms> {
  const check = registrationPageUrl(input.registrationUrl);
  if (check.outcome === 'refused') return UNREAD;
  const fetched = await deps.fetchBody(check.url);
  if (fetched.outcome !== 'fetched') {
    console.info({ outcome: fetched.outcome }, 'signup preflight: page not fetched');
    return UNREAD;
  }
  const raw = fetched.body.toString('utf8');
  const courseId = courseIdOf(check.url);
  const course =
    courseId === null
      ? null
      : readCourseTerms({
          rawHtml: raw,
          courseId,
          timeZone: input.timeZone,
          now: input.now,
          residency: input.residency,
          child: input.child,
        });
  const base = course?.ok ? course.terms : UNREAD;
  const pageText = stripHtml(raw).slice(0, MAX_PAGE_TEXT_CHARS);
  const remaining = turnRemainingMs();
  if (remaining !== undefined && remaining < PREFLIGHT_READ_MIN_TURN_MS) {
    console.info({ remaining }, 'signup preflight: too little of the turn left to read the page');
    return base;
  }
  const read = await deps.reader.read(pageText);
  return read ? applyPreflightRead(base, read, pageText) : base;
}

export function liveProgramTermsDeps(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): { fetchBody: (url: string) => Promise<RegistrationPageFetch>; reader: PreflightReader } {
  return {
    fetchBody: createRegistrationPageBytesFetch(BIND_FETCH_TIMEOUT_MS),
    reader: createPreflightReader(client),
  };
}
