import { integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * What ONE weekly registration re-verify sweep found — its own tally, written once at
 * the end of the run.
 *
 * The sweep's per-row outcomes used to leave no trace a query could read. A confirmation
 * bumps `registration_windows.verified_at`; a moved date and an unreadable page both
 * deliberately write NOTHING, which is the sweep's honesty design — an unconfirmed row
 * must stay visibly stale rather than look freshly checked. Correct for the dataset, and
 * it left the founder scorecard able to count the stale rows but never to say which of
 * the two they were: "fix a seed today" and "fix the scraper" read identically.
 *
 * Family-AGNOSTIC ops data, like the rate_limits claim it sits beside: no family_id, no
 * PII, nothing that a right-to-erasure request reaches or needs to (rule #1). Four
 * counts and a clock.
 *
 * The claim row still owns "who gets to sweep this week" (rate_limits, unique on
 * identifier+route+window_start) — this table answers the different question of what the
 * run then found, and is written only by a run that actually finished. A claimed week
 * with no row here is a sweep that died mid-flight, and the digest says exactly that
 * rather than grading it.
 */
export const registrationVerifyRuns = pgTable(
  'registration_verify_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Monday-aligned week this run swept — the same instant the rate_limits claim
     * carries, so the two are joinable by eye. */
    weekStart: timestamp('week_start', { withTimezone: true }).notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    /** Windows the run actually attempted — bounded by its own per-run ceiling, not by
     * the size of the dataset. */
    checked: integer('checked').notNull(),
    /** Read at source and bumped. The three outcomes normally sum to `checked`, but a
     * confirmation whose `verified_at` write then failed is logged and skipped, so they
     * can fall short — see the migration for why no constraint forbids that. */
    confirmed: integer('confirmed').notNull(),
    discrepancies: integer('discrepancies').notNull(),
    unverified: integer('unverified').notNull(),
  },
  (table) => ({
    // One recorded run per week. The weekly claim already makes a second run impossible;
    // this is the database saying so, and it is what lets the digest read a week's
    // outcome as a single row rather than a sum it has to trust.
    weekUniq: uniqueIndex('registration_verify_runs_week_uniq').on(table.weekStart),
  }),
);

export type RegistrationVerifyRun = typeof registrationVerifyRuns.$inferSelect;
export type NewRegistrationVerifyRun = typeof registrationVerifyRuns.$inferInsert;
