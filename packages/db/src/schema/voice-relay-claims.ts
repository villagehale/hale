import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Historical claim table for the retired ConversationRelay door.
 *
 * The writers are gone. The table stays (additive schema): dropping it would be a
 * destructive migration, and any row already written is still a CallSid with no
 * number, name, or family on it. Nothing inserts into it.
 */
export const voiceRelayClaims = pgTable(
  'voice_relay_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Twilio's id for the call. Globally unique and never reused. */
    callSid: text('call_sid').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    callSidIdx: uniqueIndex('voice_relay_claims_call_sid_uniq').on(table.callSid),
  }),
);

export type VoiceRelayClaim = typeof voiceRelayClaims.$inferSelect;
export type NewVoiceRelayClaim = typeof voiceRelayClaims.$inferInsert;
