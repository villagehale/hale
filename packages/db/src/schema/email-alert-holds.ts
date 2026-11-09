import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';

/**
 * An email alert quiet hours held, which Hale still owes (migration 0211).
 *
 * The Gmail cursor moves past a message the moment the sweep reads it, so a hold with
 * nothing behind it is a drop: an email at 07:50 was never mentioned while one at 08:05
 * was. This row is the debt. The sweep re-offers it once the gate lets the alert through,
 * by re-reading the message from Gmail and running the whole alert path again, writer
 * included, so the model still decides whether it is worth a text.
 *
 * It holds the provider's message id and nothing read from the email: no subject, no
 * sender, no snippet (rule #1). Erasure is the cascade from the hold receipt, and so from
 * the family. No FK on the connection, as `email_alert_offers` keeps none.
 */
export const emailAlertHolds = pgTable(
  'email_alert_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The `suppressed_quiet_hours` receipt the hold wrote. */
    channelMessageId: uuid('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').notNull(),
    messageId: text('message_id').notNull(),
    heldAt: timestamp('held_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The `EmailAlertOutcome` the debt ended in, paired with `closed_at` by the CHECK. */
    outcome: text('outcome'),
  },
  (table) => ({
    messageUniq: uniqueIndex('email_alert_holds_message_uniq').on(
      table.integrationId,
      table.messageId,
    ),
    openIdx: index('email_alert_holds_open_idx')
      .on(table.integrationId, table.heldAt)
      .where(sql`${table.closedAt} IS NULL`),
    channelMessageIdx: index('email_alert_holds_channel_message_idx').on(table.channelMessageId),
    closedCheck: check(
      'email_alert_holds_closed_check',
      sql`(${table.closedAt} IS NULL) = (${table.outcome} IS NULL)`,
    ),
  }),
);

export type EmailAlertHold = typeof emailAlertHolds.$inferSelect;
