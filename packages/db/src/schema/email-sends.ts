import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';
import { emailTypeEnum } from './enums.js';

/**
 * Ledger of non-transactional emails actually sent (the daily brief today). CASL
 * requires we can show, per message, who it went to and when. One row is written
 * only when the provider accepts a send, so a row here means a real email left
 * Hale. recipient is the address used; provider_message_id is the Resend id.
 */
export const emailSends = pgTable(
  'email_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailType: emailTypeEnum('email_type').notNull(),
    recipient: text('recipient').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    providerMessageId: text('provider_message_id'),
  },
  (table) => ({
    userTypeIdx: index('email_sends_user_type_idx').on(table.userId, table.emailType),
  }),
);

/**
 * A recipient's opt-out from a non-transactional email stream (CASL: every such
 * message carries a working unsubscribe). The unsubscribe route writes one row
 * per (user, email_type); the send path refuses to send when a row exists. The
 * unique index makes a repeated unsubscribe click idempotent. Transactional mail
 * (security, account) is unaffected — it is not in this enum.
 */
export const emailOptOuts = pgTable(
  'email_opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailType: emailTypeEnum('email_type').notNull(),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTypeIdx: uniqueIndex('email_opt_outs_user_type_idx').on(table.userId, table.emailType),
  }),
);

export type EmailSend = typeof emailSends.$inferSelect;
export type NewEmailSend = typeof emailSends.$inferInsert;
export type EmailOptOut = typeof emailOptOuts.$inferSelect;
export type NewEmailOptOut = typeof emailOptOuts.$inferInsert;
