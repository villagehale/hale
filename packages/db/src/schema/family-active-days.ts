import { date, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * One row per family per Toronto-local day the family opened the app — the
 * durable substrate for the retention metric ("opened 3+ times in 14 days").
 * Written by an `on conflict do nothing` upsert from the authed layout, so a
 * day is recorded at most once and carries no content, no user identity, and
 * no timestamps finer than the day (rule #1).
 */
export const familyActiveDays = pgTable(
  'family_active_days',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.day] }),
  }),
);

export type FamilyActiveDay = typeof familyActiveDays.$inferSelect;
