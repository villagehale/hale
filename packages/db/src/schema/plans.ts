import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Parent-authored plans — a private note the parent writes for their week (a
 * reminder, an errand, a family or per-child intention). Distinct from the
 * agent-proposed routine/candidates: these are the parent's own. `private`
 * defaults true and is the only mode today; public discovery is a deferred
 * post-launch build, so nothing surfaces a plan outside the family.
 *
 * childId is nullable: NULL scopes the plan to the whole family, a set value
 * scopes it to one child (FK cascades so a removed child takes its plans).
 */
export const familyPlans = pgTable(
  'family_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL = whole family; set = one child. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    private: boolean('private').notNull().default(true),
    /** When the parent marked this plan done, or NULL while it's still open. The
     * done tap also writes an immutable audit_log row (rule #6); this column is the
     * read-side state the plan page dims/settles on. Additive, nullable (rule #9). */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('family_plans_family_idx').on(table.familyId),
  }),
);

export type FamilyPlan = typeof familyPlans.$inferSelect;
export type NewFamilyPlan = typeof familyPlans.$inferInsert;
