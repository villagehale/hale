import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-441 (T14) — one "plan together" ask in a household Linq group.
 *
 * Options are the finder's own facts (name, when, where, price, link). Answers
 * live in {@link linqGroupPlanAnswers}. One live open plan per chat. A follow-up
 * is stamped once on `followed_up_at`.
 */
export const LINQ_GROUP_PLAN_STATUSES = ['open', 'settled', 'abandoned'] as const;
export type LinqGroupPlanStatus = (typeof LINQ_GROUP_PLAN_STATUSES)[number];

export const linqGroupPlans = pgTable(
  'linq_group_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    topic: text('topic').notNull(),
    options: jsonb('options').notNull().$type<LinqGroupPlanOption[]>(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    followedUpAt: timestamp('followed_up_at', { withTimezone: true }),
    optionsMessageId: text('options_message_id'),
    settledOptionId: text('settled_option_id'),
    status: text('status').notNull().$type<LinqGroupPlanStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      'linq_group_plans_status_check',
      sql`${table.status} in ('open', 'settled', 'abandoned')`,
    ),
    liveChatUniq: uniqueIndex('linq_group_plans_live_chat_uniq')
      .on(table.chatId)
      .where(sql`${table.status} = 'open'`),
    familyIdx: index('linq_group_plans_family_idx').on(table.familyId),
  }),
);

export type LinqGroupPlanOption = {
  id: string;
  name: string;
  when: string | null;
  where: string | null;
  price: string | null;
  link: string | null;
};

export type LinqGroupPlan = typeof linqGroupPlans.$inferSelect;
export type NewLinqGroupPlan = typeof linqGroupPlans.$inferInsert;

export const LINQ_GROUP_PLAN_STANCES = ['yes', 'no', 'maybe'] as const;
export type LinqGroupPlanStance = (typeof LINQ_GROUP_PLAN_STANCES)[number];

export const LINQ_GROUP_PLAN_ANSWER_SOURCES = ['text', 'tapback'] as const;
export type LinqGroupPlanAnswerSource = (typeof LINQ_GROUP_PLAN_ANSWER_SOURCES)[number];

/**
 * One person's latest yes / no / maybe on a plan. A mind-change updates the
 * same live row. A non-member (`seated` false) is stored so the case is visible
 * and never counted toward "everyone".
 */
export const linqGroupPlanAnswers = pgTable(
  'linq_group_plan_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => linqGroupPlans.id, { onDelete: 'cascade' }),
    phoneE164Hash: text('phone_e164_hash').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    displayName: text('display_name'),
    seated: text('seated').notNull(),
    stance: text('stance').notNull().$type<LinqGroupPlanStance>(),
    optionId: text('option_id'),
    source: text('source').notNull().$type<LinqGroupPlanAnswerSource>(),
    verbatim: text('verbatim').notNull(),
    interpretation: text('interpretation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stanceCheck: check(
      'linq_group_plan_answers_stance_check',
      sql`${table.stance} in ('yes', 'no', 'maybe')`,
    ),
    sourceCheck: check(
      'linq_group_plan_answers_source_check',
      sql`${table.source} in ('text', 'tapback')`,
    ),
    seatedCheck: check(
      'linq_group_plan_answers_seated_check',
      sql`${table.seated} in ('yes', 'no')`,
    ),
    livePlanPhone: uniqueIndex('linq_group_plan_answers_live_plan_phone_uniq').on(
      table.planId,
      table.phoneE164Hash,
    ),
    planIdx: index('linq_group_plan_answers_plan_idx').on(table.planId),
  }),
);

export type LinqGroupPlanAnswer = typeof linqGroupPlanAnswers.$inferSelect;
export type NewLinqGroupPlanAnswer = typeof linqGroupPlanAnswers.$inferInsert;
