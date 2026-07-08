import { pgTable, uuid, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Per-user push notification preferences. Two streams a parent controls: new
 * village picks and health reminders. Both default TRUE — a push is a
 * transactional, in-app family signal (not CASL commercial email), so the default
 * is on and a parent turns a stream off here. The row's ABSENCE means "never
 * touched, both on" (the default view), so a first-time toggle upserts the row.
 *
 * The daily brief EMAIL is deliberately NOT modelled here — it stays on the
 * existing opt-out model (email_opt_outs). Privacy (rule #1): this holds no child
 * content, only the parent's two boolean choices.
 */
export const notificationPrefs = pgTable('notification_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  pushNewPicks: boolean('push_new_picks').notNull().default(true),
  pushHealthReminders: boolean('push_health_reminders').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationPrefs = typeof notificationPrefs.$inferSelect;
export type NewNotificationPrefs = typeof notificationPrefs.$inferInsert;
