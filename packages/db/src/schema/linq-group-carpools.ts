import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-445 (T16) — one live carpool plan per group chat + day/event.
 *
 * Who is driving is read from the chat. There is no rota: Hale never assigns a
 * driver. A later claim updates the same row (a swap). Cancel sets `cancelled_at`
 * and keeps the row. The night-before reminder is scheduled on this row and
 * re-gated at send time, so a cancelled or reassigned plan cannot nag.
 */
export const LINQ_CARPOOL_STATUSES = ['open', 'assigned', 'cancelled'] as const;
export type LinqCarpoolStatus = (typeof LINQ_CARPOOL_STATUSES)[number];

export const LINQ_CARPOOL_REMINDER_STATUSES = [
  'unscheduled',
  'pending',
  'sent',
  'held_quiet',
  'skipped_cancelled',
  'skipped_no_driver',
  'suppressed',
] as const;
export type LinqCarpoolReminderStatus = (typeof LINQ_CARPOOL_REMINDER_STATUSES)[number];

export const linqGroupCarpools = pgTable(
  'linq_group_carpools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Event label + local day, so Saturday soccer and Sunday swim stay apart. */
    planKey: text('plan_key').notNull(),
    eventLabel: text('event_label'),
    pickupAt: timestamp('pickup_at', { withTimezone: true }),
    pickupPlace: text('pickup_place'),
    kids: text('kids'),
    driverName: text('driver_name'),
    driverUserId: uuid('driver_user_id').references(() => users.id, { onDelete: 'set null' }),
    driverHaleCustomer: text('driver_hale_customer').notNull().default('false'),
    driverTimezone: text('driver_timezone').notNull().default('America/Toronto'),
    status: text('status').notNull().$type<LinqCarpoolStatus>().default('open'),
    askedForDriverAt: timestamp('asked_for_driver_at', { withTimezone: true }),
    /** Provider id of Hale's one ask, so a tapback on that bubble can count as a yes. */
    askMessageId: text('ask_message_id'),
    reminderFireAt: timestamp('reminder_fire_at', { withTimezone: true }),
    reminderStatus: text('reminder_status')
      .notNull()
      .$type<LinqCarpoolReminderStatus>()
      .default('unscheduled'),
    reminderGroupSentAt: timestamp('reminder_group_sent_at', { withTimezone: true }),
    reminderDriverSentAt: timestamp('reminder_driver_sent_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      'linq_group_carpools_status_check',
      sql`${table.status} in ('open', 'assigned', 'cancelled')`,
    ),
    reminderCheck: check(
      'linq_group_carpools_reminder_status_check',
      sql`${table.reminderStatus} in ('unscheduled', 'pending', 'sent', 'held_quiet', 'skipped_cancelled', 'skipped_no_driver', 'suppressed')`,
    ),
    liveUniq: uniqueIndex('linq_group_carpools_live_chat_plan_uniq')
      .on(table.chatId, table.planKey)
      .where(sql`${table.cancelledAt} IS NULL`),
    dueIdx: index('linq_group_carpools_due_idx').on(table.reminderStatus, table.reminderFireAt),
    familyIdx: index('linq_group_carpools_family_idx').on(table.familyId),
    askIdx: index('linq_group_carpools_ask_message_idx').on(table.askMessageId),
  }),
);

export type LinqGroupCarpool = typeof linqGroupCarpools.$inferSelect;
export type NewLinqGroupCarpool = typeof linqGroupCarpools.$inferInsert;
