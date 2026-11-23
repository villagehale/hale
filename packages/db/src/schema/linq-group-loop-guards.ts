import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * VIL-728 · the group loop guard's state, one row per Linq group chat while a run is open.
 *
 * A run opens at the first group message from someone Hale has not verified as a person
 * (no verified channel on that number) after the last message from someone it has. Hale's
 * own group sends since then are counted from `channel_messages`; at the cap the chat goes
 * quiet (`quiet_since`) and Hale answers no unverified sender there until a verified person
 * speaks, which deletes the row. So a row exists only while such a run is open.
 *
 * No phone number, no name, no message text and no family id (rule #1): the chat id and two
 * clocks are the whole row. Read and written only by `apps/web/lib/channel/linq/group-loop-guard.ts`.
 */
export const linqGroupLoopGuards = pgTable('linq_group_loop_guards', {
  chatId: text('chat_id').primaryKey(),
  /** The first unverified-sender message since the last verified person spoke. */
  runStartedAt: timestamp('run_started_at', { withTimezone: true }).notNull(),
  /** When the guard tripped. Null while Hale may still answer in this run. */
  quietSince: timestamp('quiet_since', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LinqGroupLoopGuard = typeof linqGroupLoopGuards.$inferSelect;
export type NewLinqGroupLoopGuard = typeof linqGroupLoopGuards.$inferInsert;
