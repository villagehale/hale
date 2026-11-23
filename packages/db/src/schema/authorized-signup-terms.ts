import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authorizedSignupOffers } from './authorized-signup-offers.js';
import { channelMessages } from './channel-messages.js';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/** A rate as the provider's page lists it, in cents. */
export interface SignupTermsRate {
  rate: 'resident' | 'non_resident' | 'flat';
  cents: number;
}

/** The band fields of a course page, so the yes re-checks the age without the page. */
export interface SignupTermsAgeRule {
  MinAge: number | null;
  MinAgeMonths: number | null;
  MaxAge: number | null;
  MaxAgeMonths: number | null;
  StartDateValue: string | null;
}

export interface SignupTermsShownSession {
  sessionId: string;
  /** Empty when no rate was read. */
  rates: SignupTermsRate[];
  tax: 'included' | 'plus_tax' | 'unknown';
  source: 'course_model' | 'page_quote' | 'offer' | 'site_option';
}

/**
 * What the ask's text was written from. Set once, with the offer, in one transaction.
 * Program facts, ids and cents only: never a child's name, birth date or age, a postal
 * code, or a card.
 */
export interface SignupTermsShown {
  v: 1;
  read: 'course_model' | 'page_text' | 'unread';
  /** The portal's own ids (`CourseId`, `EventId`) and name. Empty and null when none. */
  program: { courseIds: string[]; name: string | null };
  residency: 'resident' | 'non_resident' | 'unknown';
  age: { fit: 'in_band' | 'unknown'; band: string | null; rule: SignupTermsAgeRule | null };
  prerequisite: { required: 'yes' | 'no' | 'unknown'; quote: string | null };
  refund: { quote: string } | null;
  /** Stated on the page, else the family's country. */
  currency: 'cad' | 'usd' | null;
  /** This ask had no stated open time, so it counts against the season's sign-ups. */
  countsAgainstSeason: boolean;
  /** An earlier run on this class may have charged: the plan stops at checkout. */
  priorChargeUnknown: boolean;
  sessions: SignupTermsShownSession[];
}

/** `rate`: this province's tax, within one cent. `ceiling`: the most tax that can pass. */
export interface SignupTermsTaxBound {
  kind: 'rate' | 'ceiling';
  basisPoints: number;
}

export type SignupTermsAmount =
  | {
      kind: 'exact';
      /**
       * The rates this approval allows, in cents. A 0 beside a paid rate is a class free at
       * one rate and paid at the other, with the family's rate unknown: never all zeros.
       */
      cents: number[];
      currency: 'cad' | 'usd' | null;
      plusTax: SignupTermsTaxBound | null;
    }
  /** Only when no rate was read: the most the parent said they would pay. */
  | { kind: 'ceiling'; cents: number; currency: 'cad' | 'usd' | null }
  | { kind: 'free' };

export interface SignupTermsApprovedSession {
  sessionId: string;
  /** The name is the page's, else the offer's activity. Null when neither gave one. */
  program: { courseIds: string[]; name: string | null };
  startsAt: string;
  /** Another offered session starts on the same day, so a missing cart time cannot pass. */
  sharesDate: boolean;
  amount: SignupTermsAmount;
}

/** Why the run stops at checkout and hands the browser over instead of paying. */
export type SignupTermsHold = 'age_unconfirmed' | 'site_option' | 'prior_charge_unknown';

/** What the yes bound. Written by code from `shown` and the parent's words, once. */
export interface SignupTermsApproved {
  v: 1;
  /** The parent's ranked choices, in the order of `plan_choice_ids`. */
  sessions: SignupTermsApprovedSession[];
  quantity: 1;
  /** The most this approval allows. Becomes `plan_max_price_cents`. Never a figure to quote. */
  maxCents: number;
  prerequisiteConfirmed: boolean | null;
  countsAgainstSeason: boolean;
  /** The season this yes took a sign-up from. Given back if no run reached the provider. */
  seasonKey: string | null;
  hold: SignupTermsHold | null;
}

/**
 * VIL-715 · the terms a registration ask showed the parent and what their yes bound to.
 * One row per offer. `shown` is written with the offer; `approved` is written once, with
 * the move to `planned`. The run reads `approved` whatever the flag says, so a plan bound
 * under the flag keeps its cart checks after the flag goes off.
 */
export const authorizedSignupTerms = pgTable(
  'authorized_signup_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => authorizedSignupOffers.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id')
      .notNull()
      .references(() => children.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shown: jsonb('shown').$type<SignupTermsShown>().notNull(),
    approved: jsonb('approved').$type<SignupTermsApproved>(),
    /** The inbound channel message that approved these terms. Never its body. */
    approvingMessageId: text('approving_message_id'),
    /**
     * The outbound row that carried the offer's own text, set only once that send was
     * accepted. Null: the parent is not known to have received these terms, so no yes binds.
     */
    askedMessageId: uuid('asked_message_id').references(() => channelMessages.id, {
      onDelete: 'set null',
    }),
    /**
     * The ask number of the text that asked whether the child has what the class needs.
     * While it is still this offer's last asked number, a plain yes answers that question.
     */
    prerequisiteAskedSeq: bigint('prerequisite_asked_seq', { mode: 'number' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneRowPerOffer: uniqueIndex('authorized_signup_terms_offer_uniq').on(table.offerId),
    familyIdx: index('authorized_signup_terms_family_idx').on(table.familyId, table.createdAt),
    approvedCheck: check(
      'authorized_signup_terms_approved_check',
      sql`(${table.approved} IS NULL) = (${table.approvedAt} IS NULL) AND (${table.approved} IS NULL) = (${table.approvingMessageId} IS NULL)`,
    ),
  }),
);

export type AuthorizedSignupTerms = typeof authorizedSignupTerms.$inferSelect;
export type NewAuthorizedSignupTerms = typeof authorizedSignupTerms.$inferInsert;
