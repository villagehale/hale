import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per inbound intake text the machine has agreed to act on — the claim that
 * makes a Twilio 15s-budget resend a refusal instead of a second full turn.
 *
 * The intake dedupe was `session.lastProviderId === providerId`, a value saved only
 * AFTER the turn's model calls and sends — so a resend arriving mid-turn passed it and
 * ran everything again (two welcome texts, doubled extractor spend, a last-write-wins
 * session clobber; the exact race migration 0085's comment records firing in production
 * for the post-intake leg). Pre-provisioning sessions write no channel_messages row, so
 * the 0085 unique index cannot arbitrate the early funnel. THE INSERT HERE IS THE CLAIM
 * (relay-claim.ts's rule): the first delivery to insert a provider id owns the turn, and
 * every later one reads its empty `returning` as 'duplicate'. It also remembers every
 * provider id in its retention window, not just the last, closing the out-of-order
 * redelivery gap.
 *
 * Family-AGNOSTIC ops data, like voice_relay_claims beside it: a MessageSid is an opaque
 * provider handle with no number, no name and no family in it, and rows age out in a day
 * (the claim path deletes as it claims). Nothing here is reachable by, or in need of, a
 * right-to-erasure sweep. Rule #1.
 *
 * `completed_at` is rule #11's half: a turn that crashed after claiming leaves
 * claimed_at set and completed_at NULL — visible residue, never silence.
 */
export const smsIntakeTurnClaims = pgTable(
  'sms_intake_turn_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Twilio's MessageSid. Globally unique and never reused. */
    providerMessageId: text('provider_message_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Stamped when the claimed turn returns an outcome. NULL past the turn's own
     * lifetime = the turn died after claiming (the named crash residue). */
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    providerMsgIdx: uniqueIndex('sms_intake_turn_claims_provider_msg_uniq').on(
      table.providerMessageId,
    ),
  }),
);

export type SmsIntakeTurnClaim = typeof smsIntakeTurnClaims.$inferSelect;
export type NewSmsIntakeTurnClaim = typeof smsIntakeTurnClaims.$inferInsert;
