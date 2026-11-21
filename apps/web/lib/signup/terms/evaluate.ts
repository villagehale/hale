import type { SignupTermsAgeRule } from '@hale/db';
import { z } from 'zod';
import { readCourseModel } from '~/lib/channel/spots/availability';
import { SPOT_PORTAL_HOSTS } from '~/lib/channel/spots/url';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import {
  type AgeEligibility,
  type CourseFacts,
  NON_RESIDENT,
  type PrepChild,
  ageEligibility,
  applicableClock,
  courseClocks,
  courseFactsSchema,
  readCourseFacts,
} from '~/lib/registration/sequence/prepare';
import { normalizeQuote } from '~/lib/registration/verify-window';
import { moneyCentsWritten } from './money';
import type { SignupTermsShown } from './types';

/**
 * VIL-715 · what a course page says about this child and this price, before Hale asks.
 * Pure. Nothing here is a guess: a field the page does not back stays unread, and the ask
 * says so. The child's date of birth stays in code and never reaches a model.
 */

export type TermsRates = SignupTermsShown['sessions'][number]['rates'];
export type TermsTax = SignupTermsShown['sessions'][number]['tax'];

export interface ProgramTerms {
  read: SignupTermsShown['read'];
  program: SignupTermsShown['program'];
  age: { fit: AgeEligibility; band: string | null; rule: SignupTermsAgeRule | null };
  prerequisite: SignupTermsShown['prerequisite'];
  refund: SignupTermsShown['refund'];
  currency: SignupTermsShown['currency'];
  rates: TermsRates;
  tax: TermsTax;
  /** The page's own open for this family, when it is still ahead. */
  pageOpensAt: Date | null;
}

const priceRowSchema = z.object({
  Name: z.string().nullish().catch(null),
  Amount: z.number().nullish().catch(null),
  DisplayAmount: z.string().nullish().catch(null),
  TaxableStateDesc: z.string().nullish().catch(null),
});

type PriceRow = z.infer<typeof priceRowSchema>;

/** A row's price in cents, only when the printed figure and the amount agree. */
function rowCents(row: PriceRow): number | null {
  if (typeof row.Amount !== 'number' || row.Amount < 0) return null;
  const cents = Math.round(row.Amount * 100);
  if (cents === 0) return 0;
  const printed = moneyCentsWritten(row.DisplayAmount ?? '');
  return printed.length === 1 && printed[0] === cents ? cents : null;
}

function rowTax(row: PriceRow): TermsTax {
  if (row.TaxableStateDesc === 'No Tax') return 'included';
  if (row.TaxableStateDesc === 'Plus Tax') return 'plus_tax';
  return 'unknown';
}

/**
 * The shape `priceClause` accepts and no other: one row, or a clean resident and
 * non-resident pair. Anything else binds no rate, because a page printing several
 * member and non-member rows is a price question code cannot answer.
 */
function ratesFrom(rawPrices: unknown, facts: CourseFacts): { rates: TermsRates; tax: TermsTax } {
  const none = { rates: [], tax: 'unknown' as const };
  const parsed = z.array(priceRowSchema).safeParse(rawPrices);
  if (!parsed.success || parsed.data.length === 0) return none;
  const rows = parsed.data;
  // A row the page's bytes did not back was dropped from `facts.Prices`.
  if (rows.length !== (facts.Prices?.length ?? 0)) return none;
  const cents = rows.map(rowCents);
  const taxes = new Set(rows.map(rowTax));
  const tax: TermsTax = taxes.size === 1 ? ([...taxes][0] as TermsTax) : 'unknown';
  const [first, second] = rows;
  const [firstCents, secondCents] = cents;
  if (rows.length === 1 && first && typeof firstCents === 'number') {
    return { rates: [{ rate: 'flat', cents: firstCents }], tax };
  }
  if (
    rows.length !== 2 ||
    !first ||
    !second ||
    typeof firstCents !== 'number' ||
    typeof secondCents !== 'number'
  ) {
    return none;
  }
  const firstIsNon = NON_RESIDENT.test(first.Name ?? '');
  const secondIsNon = NON_RESIDENT.test(second.Name ?? '');
  if (firstIsNon === secondIsNon) return none;
  const [resident, nonResident] = firstIsNon
    ? [secondCents, firstCents]
    : [firstCents, secondCents];
  return {
    rates: [
      { rate: 'resident', cents: resident },
      { rate: 'non_resident', cents: nonResident },
    ],
    tax,
  };
}

function ageRule(facts: CourseFacts): SignupTermsAgeRule {
  return {
    MinAge: facts.MinAge ?? null,
    MinAgeMonths: facts.MinAgeMonths ?? null,
    MaxAge: facts.MaxAge ?? null,
    MaxAgeMonths: facts.MaxAgeMonths ?? null,
    StartDateValue: facts.StartDateValue ?? null,
  };
}

/** The age check at the yes, from the band stored with the ask. */
export function ageFitFromRule(
  rule: SignupTermsAgeRule,
  child: PrepChild,
  ctx: { now: Date; timeZone: string },
): AgeEligibility {
  return ageEligibility(courseFactsSchema.parse(rule), child, ctx);
}

export type CourseTermsRead =
  | { ok: true; terms: ProgramTerms }
  | { ok: false; reason: 'no_model' | 'bad_model' | 'wrong_course' };

export function readCourseTerms(input: {
  rawHtml: string;
  /** The course id in the page's URL, so a page served for another class is refused. */
  courseId: string;
  timeZone: string;
  now: Date;
  residency: SignupTermsShown['residency'];
  child: PrepChild;
}): CourseTermsRead {
  const read = readCourseModel(input.rawHtml, input.courseId);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { facts } = readCourseFacts(read.model, read.blob);
  const { rates, tax } = ratesFrom((read.model as { Prices?: unknown }).Prices, facts);
  const clock = applicableClock(
    courseClocks(facts, input.timeZone),
    input.residency === 'resident',
  );
  const prerequisite: SignupTermsShown['prerequisite'] =
    facts.PrerequisiteEvents === true
      ? { required: 'yes', quote: null }
      : facts.PrerequisiteEvents === false
        ? { required: 'no', quote: null }
        : { required: 'unknown', quote: null };
  return {
    ok: true,
    terms: {
      read: 'course_model',
      program: {
        courseIds: [facts.CourseId, read.model.EventId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
        name: facts.EventName ?? null,
      },
      age: {
        fit: ageEligibility(facts, input.child, { now: input.now, timeZone: input.timeZone }),
        band: facts.AgeRestrictions ?? null,
        rule: ageRule(facts),
      },
      prerequisite,
      refund: null,
      currency: null,
      rates,
      tax,
      pageOpensAt: clock && clock.at.getTime() > input.now.getTime() ? clock.at : null,
    },
  };
}

/** A quote survives only when code finds it on the page itself. */
export function keepPageQuote(quote: string | null, pageText: string): string | null {
  if (quote === null) return null;
  const wanted = normalizeQuote(quote);
  if (!wanted || !normalizeQuote(pageText).includes(wanted)) return null;
  return quote;
}

/**
 * Whether this family lives in the town whose portal this is. Only a portal in the
 * registry names a town. A postal code that straddles the town line is unknown: the
 * portal picks the rate from the account's address, so Hale cannot assume it.
 */
export function residencyFor(host: string, postal: string | null): SignupTermsShown['residency'] {
  const portal = SPOT_PORTAL_HOSTS[host];
  if (!portal || !postal) return 'unknown';
  const places = resolveMunicipalities(postal);
  if (places.length === 0) return 'unknown';
  if (!places.includes(portal.municipality)) return 'non_resident';
  return places.length === 1 ? 'resident' : 'unknown';
}
