import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Append-only audit trail. PIPEDA right-to-access depends on this being complete.
 * Never updated, never deleted in normal operation.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** 'system', or an agent_run uuid, or a user uuid. */
    actor: text('actor').notNull(),
    actionTaken: text('action_taken').notNull(),
    targetTable: text('target_table'),
    targetId: text('target_id'),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    agentRunId: uuid('agent_run_id'),
    /**
     * VIL-635. The adult who may see this row. Null on family-wide rows and on
     * every row written before the column existed (rule #6: never rewritten).
     */
    audience: uuid('audience').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    familyTimeIdx: index('audit_log_family_time_idx').on(table.familyId, table.occurredAt),
    familyAudienceIdx: index('audit_log_family_audience_idx').on(table.familyId, table.audience),
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
