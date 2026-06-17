import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Marketing-site waitlist signups. Email is unique so a re-submission dedupes via
 * `on conflict do nothing` rather than revealing prior membership (privacy, rule #1).
 */
export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WaitlistEntry = typeof waitlist.$inferSelect;
export type NewWaitlistEntry = typeof waitlist.$inferInsert;
