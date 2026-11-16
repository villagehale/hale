import { index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Per-call Anthropic spend ledger for the prepaid-credit #ops alert.
 *
 * agent_runs.cost_usd is per-loop and family-scoped, so it misses lanes that
 * write no run row. Every Claude call Hale makes in Prod records one row here
 * from the llm-trace wrapper (token usage × the rate table in @hale/agent).
 * No family_id: this is an ops event, not a household record (rule #1).
 */
export const anthropicSpend = pgTable(
  'anthropic_spend',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
  },
  (table) => ({
    occurredAtIdx: index('anthropic_spend_occurred_at_idx').on(table.occurredAt),
  }),
);

export type AnthropicSpend = typeof anthropicSpend.$inferSelect;
export type NewAnthropicSpend = typeof anthropicSpend.$inferInsert;
