import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Stripe billing-event idempotency claim (B18). Stripe delivers each webhook
 * event at-least-once and retries on any non-2xx; the billing handler inserts the
 * event id HERE inside the same transaction that writes families.plan_tier, and
 * the unique index makes a redelivered event conflict instead of applying the tier
 * transition (and its audit_log row) twice. This is the same claim-row idiom as
 * outbound_sends — "exactly once" rides a domain row with a unique constraint, not
 * the transport. Inert until Stripe keys exist (the webhook 501s while not live).
 */
export const stripeBillingEvents = pgTable(
  'stripe_billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stripe's `evt_...` event id — the natural idempotency key. */
    eventId: text('event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventIdx: uniqueIndex('stripe_billing_events_event_idx').on(table.eventId),
  }),
);

export type StripeBillingEvent = typeof stripeBillingEvents.$inferSelect;
export type NewStripeBillingEvent = typeof stripeBillingEvents.$inferInsert;
