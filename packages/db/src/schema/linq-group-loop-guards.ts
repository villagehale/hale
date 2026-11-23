import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * VIL-728 · the group loop guard's state, one row per Linq group chat while a run is open.
 *
 * A run opens at the first group message from someone not seated in that chat after the
 * last message from someone who is. Hale's own group sends since then are counted from
 * `channel_messages`; at the cap the chat goes quiet (`quiet_since`) and Hale answers nobody
 * unseated there until a seated person speaks, which deletes the row.
 *
 * No phone number, no name, no message text and no family id (rule #1): the chat id and
 * four clocks are the whole row. Read and written only by
 * `apps/web/lib/channel/linq/group-loop-guard.ts`.
 */
export const linqGroupLoopGuards = pgTable('linq_group_loop_guards', {
  chatId: text('chat_id').primaryKey(),
  /** Linq's time on the first unseated message of this run. */
  runStartedAt: timestamp('run_started_at', { withTimezone: true }).notNull(),
  /** Linq's time on the newest unseated message. A long gap since it ends the run. */
  lastTurnAt: timestamp('last_turn_at', { withTimezone: true }).notNull(),
  /**
   * The database clock when this run opened. Hale's sends are counted against this, on
   * `channel_messages.send_recorded_at`, so neither Linq's clock nor a caller's `sent_at`
   * can move a send out of the run.
   */
  countedFrom: timestamp('counted_from', { withTimezone: true }).notNull().defaultNow(),
  /** When the guard tripped. Null while Hale may still answer in this run. */
  quietSince: timestamp('quiet_since', { withTimezone: true }),
});

export type LinqGroupLoopGuard = typeof linqGroupLoopGuards.$inferSelect;
export type NewLinqGroupLoopGuard = typeof linqGroupLoopGuards.$inferInsert;
