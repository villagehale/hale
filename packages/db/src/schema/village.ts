import {
  date,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';

/**
 * One discovered local resource (a class, group, drop-in, program) the village
 * agent surfaces for a family. childId is nullable — a candidate may be
 * family-wide rather than tied to one child. Stores coarse coverage notes only;
 * no precise location is ever persisted (rule #1).
 */
export const villageCandidates = pgTable(
  'village_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Which child this candidate is for, when attributable. Null = family-wide.
     * ON DELETE SET NULL: removing a child must not delete the family's candidates. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Free-text category (e.g. "class", "playgroup", "drop_in"); not a DB enum. */
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    sourceUrl: text('source_url'),
    /** Which discovery provider produced this row (e.g. "fake", "web_grounded"). */
    source: text('source').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    /** Coarse, human-readable coverage note (e.g. "serves your area"); never precise. */
    coverageNote: text('coverage_note'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('village_candidates_family_idx').on(table.familyId),
  }),
);

/**
 * One item within a week's routine proposal. Defined locally because @hale/db is
 * a leaf package and must not depend on @hale/types (would create a cycle) —
 * same pattern as ClassifierSuggestion in events.ts.
 */
export interface RoutineProposalItem {
  title: string;
  kind: string;
  childId: string | null;
  stageNote: string;
}

/**
 * A stage-aware weekly routine the village agent proposes for a family. The
 * unique (family_id, week_of) index makes a re-run upsert the same week's row
 * rather than duplicate it.
 */
export const routineProposals = pgTable(
  'routine_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    weekOf: date('week_of').notNull(),
    items: jsonb('items').$type<RoutineProposalItem[]>().notNull().default([]),
    /** Opaque token for a public, read-only share of this routine (viral leg).
     * Nullable: only set when a parent opts to share. UNIQUE so the token alone
     * resolves the row. */
    shareToken: text('share_token').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyWeekIdx: uniqueIndex('routine_proposals_family_week_idx').on(
      table.familyId,
      table.weekOf,
    ),
  }),
);

export type VillageCandidate = typeof villageCandidates.$inferSelect;
export type NewVillageCandidate = typeof villageCandidates.$inferInsert;
export type RoutineProposal = typeof routineProposals.$inferSelect;
export type NewRoutineProposal = typeof routineProposals.$inferInsert;
