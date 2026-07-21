import { boolean, pgTable, time, timestamp, uuid } from 'drizzle-orm/pg-core';
import { childNameLevelEnum, loopChannelEnum } from './enums.js';
import { users } from './users.js';

/**
 * F11 · The Sunday Loop — per-parent loop preferences (VIL-216 · A5). This is a
 * NEW additive store: the existing `notification_prefs` (two push booleans) and
 * `email_opt_outs` (the CASL digest opt-out) are UNTOUCHED — live crons read them,
 * and the loop taxonomy here does NOT map onto those old streams.
 *
 * "Quiet by design" (F11 principle 3) needs a real preference model the A2 send
 * seam enforces; this table is that model, and the pure hooks in
 * apps/web/lib/loop/prefs.ts read it. One row per parent (co-parents are
 * independent — each gets their own copy in their own timezone). A missing row is
 * the documented default (see DEFAULT_LOOP_PREFS), not an error, so a parent who
 * never opened Settings still has a well-defined loop.
 *
 * Timezone note: quiet hours + the weekly-plan send time are WALL-CLOCK local
 * times, interpreted in the parent's own `users.timezone` (the send day composes
 * with the parent's `users.weekStartDay` — no new timezone source). Both are
 * `time` (no zone) precisely because the zone comes from the user row.
 *
 * Privacy (rule #1): nothing here carries child content — only the parent's own
 * choices, including how much of a child's identity a message body may carry
 * (`child_name_level`), which COMPOSES WITH the deterministic teen age gate.
 */
export const loopPrefs = pgTable('loop_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The two-way exchange channel (reply-to-adjust leg). Push is always-on
   * delivery, not an exchange channel, so it is not a value here. */
  loopChannel: loopChannelEnum('loop_channel').notNull().default('email'),
  /** Per-category enables for the loop taxonomy (distinct from the old push
   * streams). Every category defaults ON — the parent turns one off here. */
  catWeeklyPlan: boolean('cat_weekly_plan').notNull().default(true),
  catReminder: boolean('cat_reminder').notNull().default(true),
  catApproval: boolean('cat_approval').notNull().default(true),
  catAlert: boolean('cat_alert').notNull().default(true),
  /** Quiet-hours window, wall-clock local (parent's users.timezone). Defaults
   * 21:30 → 07:30. start == end means "no quiet window" (deliver anytime). */
  quietHoursStart: time('quiet_hours_start').notNull().default('21:30:00'),
  quietHoursEnd: time('quiet_hours_end').notNull().default('07:30:00'),
  /** Whether time-sensitive messages (T-1h reminder, safety alert) may cross the
   * quiet window. Default ON, copy honest — normal messages always defer. */
  urgentBypassQuietHours: boolean('urgent_bypass_quiet_hours').notNull().default(true),
  /** Local time-of-day for the weekly plan; the DAY composes with the parent's
   * users.weekStartDay (the evening before the week starts → Sun for a Mon week). */
  weeklyPlanSendTime: time('weekly_plan_send_time').notNull().default('19:30:00'),
  /** How much of a child's identity a body may carry. Default 'generic' (most
   * private, rule #1); the teen age gate can only force it more private. */
  childNameLevel: childNameLevelEnum('child_name_level').notNull().default('generic'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LoopPrefsRow = typeof loopPrefs.$inferSelect;
export type NewLoopPrefsRow = typeof loopPrefs.$inferInsert;
