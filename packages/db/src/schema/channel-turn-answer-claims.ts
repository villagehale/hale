import { pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per inbound turn that has been ANSWERED — the lock beside the turn ledger's
 * audit row, so two at-least-once consumers of the same turn cannot both record a clean
 * answer (audit P1-4 seam 1).
 *
 * The ledger's re-drive gate lives in audit_log (wiring.ts auditTurnLedger), and the
 * arbiter deliberately does NOT: audit_log is append-only and immutable (rule #6), so a
 * unique index over rows the race may already have duplicated could refuse to build,
 * and the 0085 remedy — delete the losers — is unavailable there by design. THE INSERT
 * HERE IS THE CLAIM (relay-claim.ts's rule): the writer inserts this row and the
 * 'sms_turn_answered' audit row in one transaction; the loser inserts nothing anywhere
 * and reports 'already_answered'.
 *
 * Family-AGNOSTIC ops data, like voice_relay_claims beside it: one uuid pointing at a
 * channel_messages row, no body, no number, no family column. Rows age out with the
 * ledger's own 7-day lookback (the claim path deletes as it claims); the exactly-once
 * property is the unique index's, never the sweep's. Rule #1.
 */
export const channelTurnAnswerClaims = pgTable(
  'channel_turn_answer_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The inbound channel_messages row this turn answered. */
    channelMessageId: uuid('channel_message_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: uniqueIndex('channel_turn_answer_claims_message_uniq').on(
      table.channelMessageId,
    ),
  }),
);

export type ChannelTurnAnswerClaim = typeof channelTurnAnswerClaims.$inferSelect;
export type NewChannelTurnAnswerClaim = typeof channelTurnAnswerClaims.$inferInsert;
