import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * #868 · senders whose opt-out read failed twice. With no keyword list, a failed model
 * read is a stop nobody saw, so the number is held: no proactive or queued outbound
 * goes to it until a read of one of its texts succeeds. Keyed by the phone blind index
 * (rule #1: no raw number). A row is deleted the moment a read succeeds.
 */
export const optOutReadHolds = pgTable('opt_out_read_holds', {
  phoneHash: text('phone_hash').primaryKey(),
  heldAt: timestamp('held_at', { withTimezone: true }).notNull(),
});

export type OptOutReadHold = typeof optOutReadHolds.$inferSelect;
