import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { familyEvents } from './family-events.js';
import { users } from './users.js';

/**
 * VIL-102 — one open RSVP plan per Linq group chat.
 *
 * The tally lives in the chat, not on a web RSVP page. `host_family_id` is the
 * family Hale ledgers the lines against (the household that claimed the chat,
 * or the first joined family in a shared group). Event facts come only from
 * what the group said. Soft-close sets `status` to closed; the row stays.
 */
export const LINQ_GROUP_RSVP_PLAN_STATUSES = ['open', 'closed'] as const;
export type LinqGroupRsvpPlanStatus = (typeof LINQ_GROUP_RSVP_PLAN_STATUSES)[number];

export const linqGroupRsvpPlans = pgTable(
  'linq_group_rsvp_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    hostFamilyId: uuid('host_family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    title: text('title'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    location: text('location'),
    status: text('status').notNull().$type<LinqGroupRsvpPlanStatus>().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      'linq_group_rsvp_plans_status_check',
      sql`${table.status} in ('open', 'closed')`,
    ),
    liveChatUniq: uniqueIndex('linq_group_rsvp_plans_live_chat_uniq')
      .on(table.chatId)
      .where(sql`${table.status} = 'open'`),
    hostIdx: index('linq_group_rsvp_plans_host_idx').on(table.hostFamilyId),
  }),
);

export const LINQ_GROUP_RSVP_RESPONSES = ['yes', 'no', 'pending'] as const;
export type LinqGroupRsvpResponse = (typeof LINQ_GROUP_RSVP_RESPONSES)[number];

export const LINQ_GROUP_RSVP_SOURCES = ['text', 'tapback'] as const;
export type LinqGroupRsvpSource = (typeof LINQ_GROUP_RSVP_SOURCES)[number];

export const LINQ_GROUP_RSVP_CALENDAR_PERMISSIONS = ['pending', 'granted', 'refused'] as const;
export type LinqGroupRsvpCalendarPermission = (typeof LINQ_GROUP_RSVP_CALENDAR_PERMISSIONS)[number];

/**
 * One household's reply on one plan. Household is `family:<id>` when Hale
 * already knows the family, otherwise `phone:<hash>` for a member who is not
 * a Hale customer. Last write wins. Calendar columns stay null until Hale
 * asks that household and they answer.
 */
export const linqGroupRsvpReplies = pgTable(
  'linq_group_rsvp_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => linqGroupRsvpPlans.id, { onDelete: 'cascade' }),
    householdKey: text('household_key').notNull(),
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    displayName: text('display_name'),
    response: text('response').notNull().$type<LinqGroupRsvpResponse>(),
    source: text('source').notNull().$type<LinqGroupRsvpSource>(),
    verbatim: text('verbatim'),
    interpretation: text('interpretation'),
    calendarPermission: text('calendar_permission').$type<LinqGroupRsvpCalendarPermission>(),
    calendarEventId: uuid('calendar_event_id').references(() => familyEvents.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    responseCheck: check(
      'linq_group_rsvp_replies_response_check',
      sql`${table.response} in ('yes', 'no', 'pending')`,
    ),
    sourceCheck: check(
      'linq_group_rsvp_replies_source_check',
      sql`${table.source} in ('text', 'tapback')`,
    ),
    permissionCheck: check(
      'linq_group_rsvp_replies_permission_check',
      sql`${table.calendarPermission} is null or ${table.calendarPermission} in ('pending', 'granted', 'refused')`,
    ),
    planHouseholdUniq: uniqueIndex('linq_group_rsvp_replies_plan_household_uniq').on(
      table.planId,
      table.householdKey,
    ),
    planIdx: index('linq_group_rsvp_replies_plan_idx').on(table.planId),
  }),
);

export type LinqGroupRsvpPlan = typeof linqGroupRsvpPlans.$inferSelect;
export type NewLinqGroupRsvpPlan = typeof linqGroupRsvpPlans.$inferInsert;
export type LinqGroupRsvpReply = typeof linqGroupRsvpReplies.$inferSelect;
export type NewLinqGroupRsvpReply = typeof linqGroupRsvpReplies.$inferInsert;
