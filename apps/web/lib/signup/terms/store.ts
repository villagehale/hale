import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AskedAbout, type SendStamp, askStamp } from '../store';
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
    cents: z.array(z.number().int().positive()).min(1),
    currency: currencySchema,
    plusTax: z
      .object({ kind: z.enum(['rate', 'ceiling']), basisPoints: z.number().int().positive() })
      .nullable(),
    limitCents: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal('ceiling'),
    cents: z.number().int().positive(),
    currency: currencySchema,
  }),
  z.object({ kind: z.literal('free') }),
]);

export const signupTermsApprovedSchema = z.object({
  v: z.literal(1),
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        program: z.object({ courseIds: z.array(z.string()), name: z.string() }),
        startsAt: z.string(),
        sharesDate: z.boolean(),
        amount: amountSchema,
      }),
    )
    .min(1),
  quantity: z.literal(1),
  maxCents: z.number().int().nonnegative(),
  prerequisiteConfirmed: z.boolean().nullable(),
  countsAgainstSeason: z.boolean(),
  seasonKey: z.string().nullable(),
  hold: z.enum(['age_unconfirmed', 'site_option', 'prior_charge_unknown']).nullable(),
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

export async function loadSignupTerms(
  database: Database,
  input: { offerId: string; familyId: string },
): Promise<SignupTermsRead> {
  const terms = schema.authorizedSignupTerms;
  const [row] = await database
    .select({
      offerId: terms.offerId,
      shown: terms.shown,
      approved: terms.approved,
      askedMessageId: terms.askedMessageId,
    })
    .from(terms)
    .where(and(eq(terms.offerId, input.offerId), eq(terms.familyId, input.familyId)))
    .limit(1);
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

/**
 * True when any earlier run on this class for this child may have charged. Any such row
 * counts, not the latest: a held attempt ends `nothing` and must not clear the doubt.
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
  return row !== undefined;
}
