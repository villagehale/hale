import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { actions } from './actions.js';

/**
 * Outbound-send idempotency claim. The Executor inserts a row HERE before any
 * external send; the unique constraint on action_id makes a concurrent or
 * redelivered send conflict instead of double-firing. sent_at + provider id are
 * filled in after the provider confirms. This is the domain-table claim pattern
 * the worker needs because pg-boss job state lives outside Drizzle transactions
 * (so "exactly once" can't ride the job — it rides this row).
 */
export const outboundSends = pgTable(
  'outbound_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
  },
  (table) => ({
    actionIdx: uniqueIndex('outbound_sends_action_idx').on(table.actionId),
  }),
);

export type OutboundSend = typeof outboundSends.$inferSelect;
export type NewOutboundSend = typeof outboundSends.$inferInsert;
