import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * VIL-226 · the Hale sending line, as Linq last described it.
 * `paused` is true when the status is flagged or throttled. Unrequested sends
 * stop until a later webhook clears it. The number is Hale's line, not a parent's.
 */
export const linqLineHealth = pgTable('linq_line_health', {
  phoneNumber: text('phone_number').primaryKey(),
  status: text('status').notNull(),
  paused: boolean('paused').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LinqLineHealth = typeof linqLineHealth.$inferSelect;
