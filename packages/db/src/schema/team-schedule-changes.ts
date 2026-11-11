import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actions } from './actions.js';
import { families } from './families.js';
import { familyEvents } from './family-events.js';

/**
 * VIL-662 · a matched team-schedule change waiting on (or following) a
 * calendar_move / calendar_cancel. The Gmail id is a pointer for `read_email`,
 * never a body. Driver and reminder effects run once the action executes.
 */
export const TEAM_SCHEDULE_CHANGES = ['time', 'location', 'both', 'cancel'] as const;
export type TeamScheduleChangeKind = (typeof TEAM_SCHEDULE_CHANGES)[number];

export const teamScheduleChanges = pgTable(
  'team_schedule_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    familyEventId: uuid('family_event_id')
      .notNull()
      .references(() => familyEvents.id, { onDelete: 'cascade' }),
    gmailMessageId: text('gmail_message_id').notNull(),
    changeKind: text('change_kind').notNull().$type<TeamScheduleChangeKind>(),
    originalStartsAt: timestamp('original_starts_at', { withTimezone: true }).notNull(),
    timeZone: text('time_zone').notNull(),
    newStartsAt: timestamp('new_starts_at', { withTimezone: true }),
    newEndsAt: timestamp('new_ends_at', { withTimezone: true }),
    newLocation: text('new_location'),
    effectsAppliedAt: timestamp('effects_applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actionUniq: uniqueIndex('team_schedule_changes_action_uniq').on(table.actionId),
    familyIdx: index('team_schedule_changes_family_idx').on(table.familyId),
  }),
);

export type TeamScheduleChange = typeof teamScheduleChanges.$inferSelect;
export type NewTeamScheduleChange = typeof teamScheduleChanges.$inferInsert;
