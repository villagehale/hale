import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-729 · the last Checkout Session opened for a family under ONE_OPEN_CHECKOUT_ENABLED,
 * and the adult who opened it. Stripe holds whether it can still be paid. One row per
 * family; no row = none opened under the flag. Read and written only by
 * `apps/web/lib/billing/one-open-checkout.ts`.
 */
export const familyOpenCheckouts = pgTable('family_open_checkouts', {
  familyId: uuid('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  openedBy: uuid('opened_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FamilyOpenCheckout = typeof familyOpenCheckouts.$inferSelect;
