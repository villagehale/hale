import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';

/**
 * One occasion in one Gmail thread is told once (migration 0203). The email alert's
 * channel row keeps its per-message dedupe key, which is also how a parent's "not mine"
 * finds the message the text was about; this row is the claim on the OCCASION, keyed
 * `email_alert_occasion:<connection>:<thread>:<digest>` and pointing at the alert row
 * that told it.
 *
 * A table of its own, not a column on channel_messages: every insert into that table
 * names every column. The key is a digest (rule #1: it carries no title or place).
 * Erasure is the cascade from the alert row.
 */
export const emailAlertOccasions = pgTable(
  'email_alert_occasions',
  {
    occasionKey: text('occasion_key').primaryKey(),
    channelMessageId: uuid('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelMessageIdx: index('email_alert_occasions_channel_message_idx').on(
      table.channelMessageId,
    ),
  }),
);
