import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * One row per option on a Linq poll Hale sent (VIL-335).
 *
 * A poll vote webhook names an option id, not the words. This table is how that
 * id becomes the choice the router already knows how to read. The option text is
 * the label Hale itself offered — not a parent's sentence — so it is safe to
 * store. The vote webhook is matched on `option_id`, which Linq mints.
 */
export const linqPollOptions = pgTable(
  'linq_poll_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerChatId: text('provider_chat_id').notNull(),
    /** The poll-definition message. Later votes name this plus an option id. */
    providerMessageId: text('provider_message_id').notNull(),
    optionId: text('option_id').notNull(),
    optionText: text('option_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    optionUniq: uniqueIndex('linq_poll_options_option_id_uniq').on(table.optionId),
    messageIdx: index('linq_poll_options_message_idx').on(table.providerMessageId),
  }),
);

export type LinqPollOption = typeof linqPollOptions.$inferSelect;
export type NewLinqPollOption = typeof linqPollOptions.$inferInsert;
