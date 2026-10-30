import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-448 (T26) — a reminder someone in a family's Linq group asked Hale for.
 *
 * Anyone seated in the group may ask: for themselves (`sender`), for someone else by name
 * (`person`), or for the whole chat (`everyone`). `delivery` is where it goes. `group`
 * posts it in the chat. `direct` texts it 1:1, and is only ever set on the asker's own
 * reminder when they are a Hale customer — a member seated only through the group is never
 * texted 1:1 (decision 2026-10-21).
 *
 * People are held by the group seat's blind index, never by number, so a STOP or a
 * removal can cancel what they asked for or what is for them; a `person` reminder always
 * names the seat it is for. `what` is the member's own words; it is cleared when the row
 * closes. `pending` is the row before its confirmation reached the chat: an unconfirmed
 * reminder never fires. `sending` is a tick's claim while it checks and writes the text; a
 * STOP or a cancel still takes it back. `in_flight` is the text going out: written, every
 * check passed, and past the point a STOP can take it back. Either delivery's text is on
 * `channel_messages` under the dedupe key `linq:group_reminder:<id>` (group) or
 * `linq:group_reminder_direct:<id>` (1:1).
 */
export const GROUP_REMINDER_STATUSES = [
  'pending',
  'scheduled',
  'sending',
  'in_flight',
  'sent',
  'cancelled',
  'dropped',
  'failed',
] as const;
export type GroupReminderStatus = (typeof GROUP_REMINDER_STATUSES)[number];

export const GROUP_REMINDER_FOR = ['sender', 'person', 'everyone'] as const;
export type GroupReminderFor = (typeof GROUP_REMINDER_FOR)[number];

export const GROUP_REMINDER_DELIVERIES = ['group', 'direct'] as const;
export type GroupReminderDelivery = (typeof GROUP_REMINDER_DELIVERIES)[number];

export const groupReminders = pgTable(
  'group_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    /** The ask's Linq message id. With `ordinal`, a replayed webhook cannot set it twice. */
    sourceMessageId: text('source_message_id').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    askedByUserId: uuid('asked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    askedByPhoneHash: text('asked_by_phone_hash').notNull(),
    forKind: text('for_kind').notNull().$type<GroupReminderFor>(),
    forUserId: uuid('for_user_id').references(() => users.id, { onDelete: 'set null' }),
    forPhoneHash: text('for_phone_hash'),
    /** The name as the asker said it, for `person`. */
    forName: text('for_name'),
    what: text('what'),
    language: text('language').notNull().default('en'),
    /** The moment they asked for. `deliver_at` differs only when quiet hours moved it. */
    askedForAt: timestamp('asked_for_at', { withTimezone: true }).notNull(),
    deliverAt: timestamp('deliver_at', { withTimezone: true }).notNull(),
    delivery: text('delivery').notNull().$type<GroupReminderDelivery>(),
    status: text('status').notNull().default('pending').$type<GroupReminderStatus>(),
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    statusCheck: check(
      'group_reminders_status_check',
      sql`${table.status} in ('pending', 'scheduled', 'sending', 'in_flight', 'sent', 'cancelled', 'dropped', 'failed')`,
    ),
    forCheck: check(
      'group_reminders_for_kind_check',
      sql`${table.forKind} in ('sender', 'person', 'everyone')`,
    ),
    deliveryCheck: check(
      'group_reminders_delivery_check',
      sql`${table.delivery} in ('group', 'direct')`,
    ),
    directOnlyForSender: check(
      'group_reminders_direct_sender_check',
      sql`${table.delivery} = 'group' OR ${table.forKind} = 'sender'`,
    ),
    personSeated: check(
      'group_reminders_person_seated_check',
      sql`${table.forKind} <> 'person' OR ${table.forPhoneHash} IS NOT NULL`,
    ),
    whatLength: check(
      'group_reminders_what_length_check',
      sql`${table.what} IS NULL OR char_length(${table.what}) <= 300`,
    ),
    sourceUniq: uniqueIndex('group_reminders_source_uniq').on(table.sourceMessageId, table.ordinal),
    dueIdx: index('group_reminders_due_idx').on(table.status, table.deliverAt),
    chatIdx: index('group_reminders_chat_idx').on(table.chatId, table.status),
  }),
);

export type GroupReminder = typeof groupReminders.$inferSelect;
export type NewGroupReminder = typeof groupReminders.$inferInsert;
