import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * VIL-226 · Hale's sending line, as Linq last described it
 * (`phone_number.status_updated`). `paused` is true when the line is flagged or
 * throttled; unrequested sends stop until a later webhook clears it. The number is
 * Hale's own line, not a parent's.
 */
export const linqLineHealth = pgTable('linq_line_health', {
  phoneNumber: text('phone_number').primaryKey(),
  status: text('status').notNull(),
  paused: boolean('paused').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LinqLineHealth = typeof linqLineHealth.$inferSelect;
