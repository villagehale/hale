import { integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * Per-family Browser Use signup attempts in one registration season.
 * `season_key` is `registrationSeasonOf` (`YYYY-winter` etc.). `attempted`
 * counts only runs that reached the Browser Use engine, not dry-runs or
 * preflight skips. No child names, URLs, or other PII (rule #1).
 */
export const familySignupHelpSeasons = pgTable(
  'family_signup_help_seasons',
  {
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    seasonKey: text('season_key').notNull(),
    attempted: integer('attempted').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.familyId, table.seasonKey] }),
  }),
);

export type FamilySignupHelpSeason = typeof familySignupHelpSeasons.$inferSelect;
export type NewFamilySignupHelpSeason = typeof familySignupHelpSeasons.$inferInsert;
