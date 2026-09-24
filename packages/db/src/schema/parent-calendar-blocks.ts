import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { integrations } from './integrations.js';
import { users } from './users.js';

/**
 * Free/busy memory for one event on one parent's Google Calendar.
 *
 * The connector sweep is a delta reader. Intersection, handoff, and a follow-up
 * after the event need the shape to still be here on the next tick.
 *
 * A non-kid row holds when it is and nothing else. The CHECK is what makes that
 * true: `title` is allowed only when `kid_related` is true. Descriptions,
 * attendees, and locations are not columns.
 */
export const parentCalendarBlocks = pgTable(
  'parent_calendar_blocks',
  {
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    allDay: boolean('all_day').notNull().default(false),
    kidRelated: boolean('kid_related').notNull(),
    /** Present only for a kid-related row. The CHECK rejects any other title. */
    title: text('title'),
    recurringEventId: text('recurring_event_id'),
    status: text('status').notNull(),
    updatedStamp: text('updated_stamp').notNull(),
    /** Set once the group has been told, or immediately when there is nothing
     * to tell (non-kid, seeding, or the other calendar is not connected yet). */
    announcedAt: timestamp('announced_at', { withTimezone: true }),
    /** Set once the after-event follow-up has gone to the group. */
    followupAt: timestamp('followup_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.integrationId, table.eventId] }),
    familyStartIdx: index('parent_calendar_blocks_family_start_idx').on(
      table.familyId,
      table.startAt,
    ),
    titleKidOnly: check(
      'parent_calendar_blocks_title_kid_only',
      sql`${table.kidRelated} OR ${table.title} IS NULL`,
    ),
  }),
);

export type ParentCalendarBlock = typeof parentCalendarBlocks.$inferSelect;
export type NewParentCalendarBlock = typeof parentCalendarBlocks.$inferInsert;
