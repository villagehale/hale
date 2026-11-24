import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AskedAbout, type SendStamp, askStamp } from '../store';
import { registrationPreflightEnabled } from './flag';
import type { SignupTermsApproved, SignupTermsShown } from './types';

/**
 * VIL-715 · reads and writes of the one terms row an offer carries. `approved` is written
 * only inside `approveSignupPlan`, in the same transaction as the move to `planned`.
 */

const rateSchema = z.object({
  rate: z.enum(['resident', 'non_resident', 'flat']),
  cents: z.number().int().nonnegative(),
});

const currencySchema = z.enum(['cad', 'usd']).nullable();

export const signupTermsShownSchema = z.object({
  v: z.literal(1),
  read: z.enum(['course_model', 'page_text', 'unread']),
  program: z.object({ courseIds: z.array(z.string()), name: z.string().nullable() }),
  residency: z.enum(['resident', 'non_resident', 'unknown']),
  age: z.object({
    fit: z.enum(['in_band', 'unknown']),
    band: z.string().nullable(),
    rule: z
      .object({
        MinAge: z.number().nullable(),
        MinAgeMonths: z.number().nullable(),
        MaxAge: z.number().nullable(),
        MaxAgeMonths: z.number().nullable(),
        StartDateValue: z.string().nullable(),
      })
      .nullable(),
  }),
  prerequisite: z.object({
    required: z.enum(['yes', 'no', 'unknown']),
    quote: z.string().nullable(),
  }),
  refund: z.object({ quote: z.string() }).nullable(),
  currency: currencySchema,
  countsAgainstSeason: z.boolean(),
  priorChargeUnknown: z.boolean(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      rates: z.array(rateSchema),
      tax: z.enum(['included', 'plus_tax', 'unknown']),
      source: z.enum(['course_model', 'page_quote', 'offer', 'site_option']),
    }),
  ),
});

const amountSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exact'),
    // A 0 is one rate of a free-or-paid pair. All zeros is `free`, and never stored as this.
    cents: z
      .array(z.number().int().nonnegative())
      .min(1)
      .refine((rates) => rates.some((cents) => cents > 0)),
    currency: currencySchema,
    plusTax: z
      .object({ kind: z.enum(['rate', 'ceiling']), basisPoints: z.number().int().positive() })
      .nullable(),
  }),
  z.object({ kind: z.literal('unstated') }),
  z.object({ kind: z.literal('free') }),
]);

export const signupTermsApprovedSchema = z.object({
  v: z.literal(1),
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        program: z.object({ courseIds: z.array(z.string()), name: z.string().nullable() }),
        startsAt: z.string(),
        sharesDate: z.boolean(),
        amount: amountSchema,
      }),
    )
    .min(1),
  quantity: z.literal(1),
  maxCents: z.number().int().nonnegative(),
  countsAgainstSeason: z.boolean(),
  seasonKey: z.string().nullable(),
  hold: z
    .enum([
      'age_unconfirmed',
      'site_option',
      'prior_charge_unknown',
      'price_unstated',
      'prerequisite_unconfirmed',
    ])
    .nullable(),
});

export interface SignupTermsRow {
  offerId: string;
  shown: SignupTermsShown;
  approved: SignupTermsApproved | null;
  askedMessageId: string | null;
}

/**
 * What the row holds, read through its schema. `unreadable`: a row exists and code cannot
 * trust it, so the caller hands the plan back instead of paying on its maximum alone.
 */
export type SignupTermsRead =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'read'; row: SignupTermsRow };

/** Preview shares the Prod database and does not migrate: there, this table can be absent. */
function isMissingTable(err: unknown): boolean {
  const fields = err as { code?: string; cause?: { code?: string } } | null;
  return fields?.code === '42P01' || fields?.cause?.code === '42P01';
}

export async function loadSignupTerms(
  database: Database,
  input: { offerId: string; familyId: string },
): Promise<SignupTermsRead> {
  const terms = schema.authorizedSignupTerms;
  let rows: {
    offerId: string;
    shown: unknown;
    approved: unknown;
    askedMessageId: string | null;
  }[];
  try {
    rows = await database
      .select({
        offerId: terms.offerId,
        shown: terms.shown,
        approved: terms.approved,
        askedMessageId: terms.askedMessageId,
      })
      .from(terms)
      .where(and(eq(terms.offerId, input.offerId), eq(terms.familyId, input.familyId)))
      .limit(1);
  } catch (err) {
    if (isMissingTable(err)) return { status: 'none' };
    throw err;
  }
  const [row] = rows;
  if (!row) return { status: 'none' };
  const shown = signupTermsShownSchema.safeParse(row.shown);
  const approved = row.approved === null ? null : signupTermsApprovedSchema.safeParse(row.approved);
  if (!shown.success || (approved !== null && !approved.success)) {
    return { status: 'unreadable' };
  }
  return {
    status: 'read',
    row: {
      offerId: row.offerId,
      shown: shown.data,
      approved: approved === null ? null : (approved.data as SignupTermsApproved),
      askedMessageId: row.askedMessageId,
    },
  };
}

/** This ask goes by the terms lane: a text it owes that cannot be written is paged. */
export async function askIsOnTerms(
  database: Database,
  familyId: string,
  offerId: string,
): Promise<boolean> {
  if (registrationPreflightEnabled(familyId)) return true;
  return (await loadSignupTerms(database, { offerId, familyId })).status !== 'none';
}

/**
 * The stamp for the send that carries an offer's own text. After the ordinary keep, it
 * records that row on the terms: only then does a yes bind them. A question back about the
 * ask stamps the ask and leaves this null, because that text did not carry the terms.
 */
export function termsAskStamp(database: Database, asks: AskedAbout): SendStamp {
  const stamp = askStamp(database, asks);
  return async () => {
    const keep = await stamp();
    return async (channelMessageId) => {
      const kept = await keep(channelMessageId);
      const terms = schema.authorizedSignupTerms;
      await database
        .update(terms)
        .set({ askedMessageId: channelMessageId })
        .where(
          and(
            eq(terms.familyId, asks.familyId),
            inArray(terms.offerId, [...asks.offerIds]),
            isNull(terms.approvedAt),
          ),
        );
      return kept;
    };
  };
}

/** Whether any of these offers carries a terms row, whatever the flag says now. */
export async function someOfferHasTerms(
  database: Database,
  input: { familyId: string; offerIds: readonly string[] },
): Promise<boolean> {
  if (input.offerIds.length === 0) return false;
  const terms = schema.authorizedSignupTerms;
  try {
    const [row] = await database
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.familyId, input.familyId), inArray(terms.offerId, [...input.offerIds])))
      .limit(1);
    return row !== undefined;
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}

/** Which of these offers carry a terms row, whatever the flag says now. */
export async function offersWithTerms(
  database: Database,
  input: { familyId: string; offerIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  if (input.offerIds.length === 0) return new Set();
  const terms = schema.authorizedSignupTerms;
  try {
    const rows = await database
      .select({ offerId: terms.offerId })
      .from(terms)
      .where(and(eq(terms.familyId, input.familyId), inArray(terms.offerId, [...input.offerIds])));
    return new Set(rows.map((row) => row.offerId));
  } catch (err) {
    if (isMissingTable(err)) return new Set();
    throw err;
  }
}

/**
 * True when any earlier run on this class for this child may have charged. Any such row
 * counts, not the latest: a held attempt ends `nothing` and must not clear the doubt. An
 * offer moved out of `submitting` with a payment or review under way and no `plan_finished`
 * row counts too: the sweep died between the two writes, and what it charged was never read.
 */
export async function priorChargeUnknown(
  database: Database,
  input: { familyId: string; childId: string; activityKey: string },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const audit = schema.auditLog;
  const [row] = await database
    .select({ id: audit.id })
    .from(audit)
    .innerJoin(offers, sql`${offers.id}::text = ${audit.targetId}`)
    .where(
      and(
        eq(audit.familyId, input.familyId),
        eq(audit.actionTaken, 'authorized_signup_step'),
        sql`${audit.after}->>'step' = 'plan_finished'`,
        sql`${audit.after}->>'charged' = 'unknown'`,
        eq(offers.familyId, input.familyId),
        eq(offers.childId, input.childId),
        eq(offers.activityKey, input.activityKey),
      ),
    )
    .limit(1);
  if (row) return true;
  const [unfinished] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.familyId, input.familyId),
        eq(offers.childId, input.childId),
        eq(offers.activityKey, input.activityKey),
        eq(offers.status, 'handed_back'),
        sql`(${offers.planResume}->>'phase' = 'paying' or ${offers.planResume}->>'reviewStarted' = 'true')`,
        notExists(
          database
            .select({ id: audit.id })
            .from(audit)
            .where(
              and(
                eq(audit.familyId, input.familyId),
                eq(audit.actionTaken, 'authorized_signup_step'),
                sql`${audit.targetId} = ${offers.id}::text`,
                sql`${audit.after}->>'step' = 'plan_finished'`,
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return unfinished !== undefined;
}
