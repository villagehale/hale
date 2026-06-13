import { pgTable, uuid, date, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * One per-family-per-day digest summary the web app renders. The worker's
 * runDailyDigest computes the day's action tallies and writes a row here; the
 * unique (family_id, digest_date) index makes a re-run upsert the same row
 * rather than duplicate it (digests are recomputed idempotently per day).
 *
 * Counts mirror the action user-visible states runDailyDigest buckets:
 *   handled    — actions Hearth executed autonomously
 *   awaiting   — actions drafted, waiting on a parent's approval
 *   needsYou   — actions that need a human (reviewer flagged / failed)
 *   reverted   — actions a parent rolled back
 */
export const dailyDigests = pgTable(
  'daily_digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    digestDate: date('digest_date').notNull(),
    handledCount: integer('handled_count').notNull().default(0),
    awaitingCount: integer('awaiting_count').notNull().default(0),
    needsYouCount: integer('needs_you_count').notNull().default(0),
    revertedCount: integer('reverted_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyDateIdx: uniqueIndex('daily_digests_family_date_idx').on(
      table.familyId,
      table.digestDate,
    ),
  }),
);

export type DailyDigest = typeof dailyDigests.$inferSelect;
export type NewDailyDigest = typeof dailyDigests.$inferInsert;
