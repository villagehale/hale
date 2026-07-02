import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Per-device Expo push tokens, one row per device. A device registers its token
 * against the signed-in user (`user_id` → users.id); the token is the thing Expo's
 * push API addresses. `expo_push_token` is UNIQUE so a device that re-registers
 * (e.g. after a reinstall under a different account) re-points to the current user
 * via upsert-on-conflict rather than duplicating rows. `last_seen_at` is bumped on
 * every re-registration so stale tokens are distinguishable; `platform` records
 * ios/android for later per-platform sends.
 *
 * Privacy (rule #1): the token value is a device address, never a child's content;
 * it is never logged (see /api/push/register and lib/push/send).
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoPushToken: text('expo_push_token').notNull().unique(),
    platform: text('platform'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('push_tokens_user_idx').on(table.userId),
  }),
);

export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;
