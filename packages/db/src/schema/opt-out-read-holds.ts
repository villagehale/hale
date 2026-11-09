import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * #868 · the per-number hold written before VIL-553. It pointed at no message, so it
 * could only be released by "some later text from this number read fine", which let a
 * stop sent during an outage be lost. Never written since VIL-553; a standing row is
 * re-pointed at its number's inbound messages by the opt-out recovery pass
 * (opt-out-recovery.ts) and then deleted. Keyed by the phone blind index (rule #1).
 */
export const optOutReadHolds = pgTable('opt_out_read_holds', {
  phoneHash: text('phone_hash').primaryKey(),
  heldAt: timestamp('held_at', { withTimezone: true }).notNull(),
  /** Its placeable texts are held by message. Set only on a row that still stands for a
   * text it could not place, so those texts are re-pointed once, never every tick. */
  repointedAt: timestamp('repointed_at', { withTimezone: true }),
});

export type OptOutReadHold = typeof optOutReadHolds.$inferSelect;

/**
 * VIL-553 · one row per text whose opt-out read failed, keyed by the provider's message
 * id. A number is held from proactive and queued sends while any row for its phone hash
 * stands. A row is deleted only when that exact text has been read, or when nothing can
 * text the number any more. `next_read_at` is both the recovery claim and its back-off.
 * The text itself is never stored here.
 */
export const optOutHeldMessages = pgTable(
  'opt_out_held_messages',
  {
    providerMessageId: text('provider_message_id').primaryKey(),
    phoneHash: text('phone_hash').notNull(),
    heldAt: timestamp('held_at', { withTimezone: true }).notNull(),
    nextReadAt: timestamp('next_read_at', { withTimezone: true }).notNull(),
    readAttempts: integer('read_attempts').notNull().default(0),
    /** VIL-602 · what the text was first read as, when it was read as a crisis: its
     * language, and the situation and who from their closed lists. Here, not on the crisis
     * claim, so they go when the row goes, and an erasure clears them. */
    crisisLanguage: text('crisis_language'),
    crisisSituation: text('crisis_situation'),
    crisisWho: text('crisis_who'),
  },
  (t) => ({
    phoneIdx: index('opt_out_held_messages_phone_idx').on(t.phoneHash),
    nextReadIdx: index('opt_out_held_messages_next_read_idx').on(t.nextReadAt),
  }),
);

export type OptOutHeldMessage = typeof optOutHeldMessages.$inferSelect;
