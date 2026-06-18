import { pgTable, uuid, date, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * Per-child activity breakdown carried alongside the family-level totals. One
 * section per child the day's actions could be attributed to, plus an
 * `unattributed` bucket for actions whose event had no child_id (family-wide or
 * undeterminable). The family-level *_count columns stay the source of truth for
 * the existing reader; this is purely additive — a newborn+teenager family can
 * see each child's activity distinctly. coordinationFlags surface sibling
 * calendar-overlap coordination signals (a flag, never a block).
 */
export interface DigestPerChildBreakdown {
  children: Array<{
    childId: string;
    name: string;
    handledCount: number;
    awaitingCount: number;
    needsYouCount: number;
    revertedCount: number;
    totalCount: number;
  }>;
  unattributed: {
    handledCount: number;
    awaitingCount: number;
    needsYouCount: number;
    revertedCount: number;
    totalCount: number;
  };
  coordinationFlags: Array<{
    kind: 'sibling_calendar_overlap';
    actionId: string;
    childId: string | null;
    siblingChildId: string;
    detail: string;
  }>;
  /**
   * Personalized child-development nudges (F1 companion) — a retention touch
   * derived per child from date_of_birth: a soon-due routine health item and a
   * milestone worth watching this stage. Supportive, never diagnostic (rule #1).
   * Additive: existing readers ignore this; absent on rows written before it.
   */
  companionHighlights?: Array<{
    childId: string;
    name: string;
    /** Short, parent-facing nudges, e.g. "Maya's 4-month immunizations are due in 1 week". */
    notes: string[];
  }>;
}

/**
 * One per-family-per-day digest summary the web app renders. The worker's
 * runDailyDigest computes the day's action tallies and writes a row here; the
 * unique (family_id, digest_date) index makes a re-run upsert the same row
 * rather than duplicate it (digests are recomputed idempotently per day).
 *
 * Counts mirror the action user-visible states runDailyDigest buckets:
 *   handled    — actions Hale executed autonomously
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
    /** Per-child sections + an unattributed bucket + sibling coordination flags.
     * Additive: the family-level *_count columns remain the reader's contract;
     * this enriches a multi-child family's digest. Null on rows written before
     * this column existed (additive migration 0004). */
    perChildBreakdown: jsonb('per_child_breakdown').$type<DigestPerChildBreakdown>(),
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
