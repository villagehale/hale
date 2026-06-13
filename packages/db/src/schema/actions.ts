import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { events } from './events.js';
import { reviewerVerdictEnum, actionUserVisibleStateEnum } from './enums.js';

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Reference to agent_runs.id of the Drafter run that produced this. */
    draftedByAgentRunId: uuid('drafted_by_agent_run_id'),
    reviewerVerdict: reviewerVerdictEnum('reviewer_verdict').notNull().default('pending'),
    reviewerVerdictAt: timestamp('reviewer_verdict_at', { withTimezone: true }),
    reviewerToolResults: jsonb('reviewer_tool_results')
      .$type<Array<{ tool: string; ok: boolean; result: unknown }>>()
      .notNull()
      .default([]),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    executorResult: jsonb('executor_result').$type<Record<string, unknown>>(),
    userVisibleState: actionUserVisibleStateEnum('user_visible_state')
      .notNull()
      .default('drafted_for_approval'),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedReason: text('reverted_reason'),
  },
  (table) => ({
    familyStateIdx: index('actions_family_state_idx').on(
      table.familyId,
      table.userVisibleState,
      table.draftedAt,
    ),
    // One action per event — a crash between recordAction and the next
    // checkpoint must not let a redelivery mint a phantom duplicate (FIX 2).
    eventIdx: uniqueIndex('actions_event_idx').on(table.eventId),
  }),
);

export type Action = typeof actions.$inferSelect;
export type NewAction = typeof actions.$inferInsert;
