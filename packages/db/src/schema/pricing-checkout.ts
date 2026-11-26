import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * A paid Checkout Session from /pricing, before any family exists.
 *
 * The phone is encrypted. The blind index is how a later verified code finds
 * the same number. `bound_at` stays null until that code verifies — a replay
 * of the webhook must not clear it. No audit row is written here: audit_log
 * requires a family, and this row is the family-less record.
 */
export const pricingCheckoutPayments = pgTable(
  'pricing_checkout_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeSessionId: text('stripe_session_id').notNull(),
    tier: text('tier').$type<'plus' | 'family'>().notNull(),
    sku: text('sku'),
    currency: text('currency'),
    phoneE164Encrypted: text('phone_e164_encrypted'),
    phoneE164Hash: text('phone_e164_hash'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    boundFamilyId: uuid('bound_family_id').references(() => families.id, { onDelete: 'set null' }),
    boundPhoneE164Hash: text('bound_phone_e164_hash'),
    boundAt: timestamp('bound_at', { withTimezone: true }),
    /** Set when the subscription ends before this row is bound. Verify then refuses. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /**
     * First-touch attribution (query string). No phone and no email. Written
     * once, with the row, so bind can attribute signup without fetching Stripe.
     */
    attribution: text('attribution'),
    /** Consented PostHog distinct id. Null when analytics consent was not granted. */
    analyticsDistinctId: text('analytics_distinct_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionUniq: uniqueIndex('pricing_checkout_payments_session_uniq').on(table.stripeSessionId),
    phoneIdx: index('pricing_checkout_payments_phone_idx').on(table.phoneE164Hash),
  }),
);

/**
 * One-time codes for a pricing checkout. The code itself is stored only as a
 * hash. One live (unconsumed) code per session. A failed send deletes its row
 * so a code that never left is not a code.
 */
export const pricingCheckoutCodes = pgTable(
  'pricing_checkout_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeSessionId: text('stripe_session_id')
      .notNull()
      .references(() => pricingCheckoutPayments.stripeSessionId, { onDelete: 'cascade' }),
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    phoneE164Hash: text('phone_e164_hash').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index('pricing_checkout_codes_session_idx').on(table.stripeSessionId),
    phoneIdx: index('pricing_checkout_codes_phone_idx').on(table.phoneE164Hash),
    oneLive: uniqueIndex('pricing_checkout_codes_one_live')
      .on(table.stripeSessionId)
      .where(sql`${table.consumedAt} IS NULL`),
  }),
);

export type PricingCheckoutPayment = typeof pricingCheckoutPayments.$inferSelect;
export type PricingCheckoutCode = typeof pricingCheckoutCodes.$inferSelect;
