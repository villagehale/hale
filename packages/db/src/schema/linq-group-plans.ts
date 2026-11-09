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
 * VIL-442 (T15) — one live plan being RSVP-tracked in a Linq group chat.
 *
 * Any plan, not a birthday: a picnic, a museum Saturday, soccer, a class party.
 * The covering family is the household that claimed the chat (T22: one family's
 * plan covers everyone seated). `expected_count` is how many distinct people or
 * households Hale is waiting on. Closed rows stay; a chat has at most one live
 * plan.
 */
export const linqGroupPlans = pgTable(
  'linq_group_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    location: text('location'),
    rsvpDeadlineAt: timestamp('rsvp_deadline_at', { withTimezone: true }),
    expectedCount: integer('expected_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expectedCheck: check(
      'linq_group_plans_expected_count_check',
      sql`${table.expectedCount} >= 0 AND ${table.expectedCount} <= 80`,
    ),
    liveChatUniq: uniqueIndex('linq_group_plans_live_chat_uniq')
      .on(table.chatId)
      .where(sql`${table.closedAt} IS NULL`),
    familyIdx: index('linq_group_plans_family_idx').on(table.familyId),
  }),
);

export const GROUP_PLAN_RSVP_RESPONSES = ['yes', 'no', 'maybe'] as const;
export type GroupPlanRsvpResponse = (typeof GROUP_PLAN_RSVP_RESPONSES)[number];

export const GROUP_PLAN_RSVP_SOURCES = ['text', 'tapback', 'on_behalf'] as const;
export type GroupPlanRsvpSource = (typeof GROUP_PLAN_RSVP_SOURCES)[number];

/**
 * One person's (or household's) answer on a group plan.
 *
 * `member_key` is the per-plan natural key: a phone blind index when Hale has
 * a handle, otherwise a folded display name. Re-answering UPDATES the row, so
 * an edit cannot add a second head. `covers_keys` lists other member keys this
 * answer stands for (a parent RSVPing the whole household). Pending people are
 * expected keys with no row.
 */
export const linqGroupPlanRsvps = pgTable(
  'linq_group_plan_rsvps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => linqGroupPlans.id, { onDelete: 'cascade' }),
    memberKey: text('member_key').notNull(),
    displayName: text('display_name').notNull(),
    householdLabel: text('household_label'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    haleCustomer: text('hale_customer').notNull().default('false'),
    response: text('response').notNull(),
    headcount: integer('headcount').notNull().default(1),
    source: text('source').notNull(),
    coversKeys: text('covers_keys').notNull().default('[]'),
    verbatim: text('verbatim'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    responseCheck: check(
      'linq_group_plan_rsvps_response_check',
      sql`${table.response} in ('yes', 'no', 'maybe')`,
    ),
    sourceCheck: check(
      'linq_group_plan_rsvps_source_check',
      sql`${table.source} in ('text', 'tapback', 'on_behalf')`,
    ),
    haleCustomerCheck: check(
      'linq_group_plan_rsvps_hale_customer_check',
      sql`${table.haleCustomer} in ('true', 'false')`,
    ),
    headcountCheck: check(
      'linq_group_plan_rsvps_headcount_check',
      sql`${table.headcount} >= 1 AND ${table.headcount} <= 20`,
    ),
    planMemberUniq: uniqueIndex('linq_group_plan_rsvps_plan_member_uniq').on(
      table.planId,
      table.memberKey,
    ),
    planIdx: index('linq_group_plan_rsvps_plan_idx').on(table.planId),
  }),
);

/**
 * Expected people on a plan. Written when tracking starts (seated members plus
 * anyone already in the chat) and when a new person answers. Waiting = these
 * keys minus RSVP rows (and minus keys covered by an on-behalf answer).
 */
export const linqGroupPlanExpected = pgTable(
  'linq_group_plan_expected',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => linqGroupPlans.id, { onDelete: 'cascade' }),
    memberKey: text('member_key').notNull(),
    displayName: text('display_name').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    haleCustomer: text('hale_customer').notNull().default('false'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    haleCustomerCheck: check(
      'linq_group_plan_expected_hale_customer_check',
      sql`${table.haleCustomer} in ('true', 'false')`,
    ),
    planMemberUniq: uniqueIndex('linq_group_plan_expected_plan_member_uniq').on(
      table.planId,
      table.memberKey,
    ),
    planIdx: index('linq_group_plan_expected_plan_idx').on(table.planId),
  }),
);

/**
 * Follow-up send claims. One wave per plan: the claim wins only while
 * `sent_at` is null, so two cron ticks cannot both text the group.
 */
export const linqGroupPlanFollowups = pgTable(
  'linq_group_plan_followups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => linqGroupPlans.id, { onDelete: 'cascade' }),
    wave: integer('wave').notNull().default(1),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    waveCheck: check('linq_group_plan_followups_wave_check', sql`${table.wave} >= 1`),
    planWaveUniq: uniqueIndex('linq_group_plan_followups_plan_wave_uniq').on(
      table.planId,
      table.wave,
    ),
  }),
);

export type LinqGroupPlan = typeof linqGroupPlans.$inferSelect;
export type NewLinqGroupPlan = typeof linqGroupPlans.$inferInsert;
export type LinqGroupPlanRsvp = typeof linqGroupPlanRsvps.$inferSelect;
export type NewLinqGroupPlanRsvp = typeof linqGroupPlanRsvps.$inferInsert;
export type LinqGroupPlanExpected = typeof linqGroupPlanExpected.$inferSelect;
export type LinqGroupPlanFollowup = typeof linqGroupPlanFollowups.$inferSelect;
