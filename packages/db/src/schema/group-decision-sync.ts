import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * A 1:1 activity decision waiting to be told to the claimed Linq group.
 *
 * One row per decision. The flush waits until the 1:1 has been quiet, then
 * sends at most one bubble (up to three lines) and marks every waiting row
 * for that family flushed, including lines past the third. Nothing here is a
 * mailbox subject or a non-kid title: the columns are the template slots.
 */
export const groupDecisionSync = pgTable(
  'group_decision_sync',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originChatId: text('origin_chat_id'),
    decision: text('decision').notNull(),
    activity: text('activity').notNull(),
    kid: text('kid').notNull(),
    day: text('day'),
    time: text('time'),
    flushAfter: timestamp('flush_after', { withTimezone: true }).notNull(),
    flushedAt: timestamp('flushed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyFlushIdx: index('group_decision_sync_family_flush_idx').on(
      table.familyId,
      table.flushedAt,
      table.flushAfter,
    ),
  }),
);

export type GroupDecisionSync = typeof groupDecisionSync.$inferSelect;
export type NewGroupDecisionSync = typeof groupDecisionSync.$inferInsert;
