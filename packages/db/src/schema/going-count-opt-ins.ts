import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-399 — this household's explicit yes to being counted in "who else is going".
 *
 * The row is THIS household's decision. It does not name another household, a
 * child, a class, or a place. A household that booked and did not opt in has
 * no row here, so a reader of this table cannot learn that they go.
 *
 * One live row per household. A later no sets `revoked_at` rather than deleting
 * the yes, so the withdrawal is a fact (rule #6). The family cascade is the
 * erasure path.
 */
export const goingCountOptIns = pgTable(
  'going_count_opt_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The parent who said the word. Their leaving the household ends the yes. */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    liveUniq: uniqueIndex('going_count_opt_ins_live_uniq')
      .on(table.familyId)
      .where(sql`${table.revokedAt} IS NULL`),
    familyIdx: index('going_count_opt_ins_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type GoingCountOptIn = typeof goingCountOptIns.$inferSelect;
export type NewGoingCountOptIn = typeof goingCountOptIns.$inferInsert;
