import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { events } from './events.js';
import { actions } from './actions.js';
import { agentNameEnum, agentRunStatusEnum } from './enums.js';

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),
    agentName: agentNameEnum('agent_name').notNull(),
    modelUsed: text('model_used').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),
    promptCacheHit: boolean('prompt_cache_hit'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    status: agentRunStatusEnum('status').notNull().default('in_progress'),
    parentRunId: uuid('parent_run_id'),
    /** Langfuse trace id for cross-reference. */
    langfuseTraceId: text('langfuse_trace_id'),
  },
  (table) => ({
    familyCostIdx: index('agent_runs_family_cost_idx').on(
      table.familyId,
      table.startedAt,
      table.costUsd,
    ),
    eventIdx: index('agent_runs_event_idx').on(table.eventId),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
