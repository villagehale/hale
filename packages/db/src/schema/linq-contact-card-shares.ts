import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row per Linq chat that has already received Hale's Name and Photo card.
 *
 * Written only after Linq accepts the share. No row means the next successful
 * send may try again, including after error 2012. `chat_id` is Linq's chat id,
 * the same value already stored as provider_chat_id. No phone number and no
 * message body.
 */
export const linqContactCardShares = pgTable('linq_contact_card_shares', {
  chatId: text('chat_id').primaryKey(),
  sharedAt: timestamp('shared_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LinqContactCardShare = typeof linqContactCardShares.$inferSelect;
export type NewLinqContactCardShare = typeof linqContactCardShares.$inferInsert;
