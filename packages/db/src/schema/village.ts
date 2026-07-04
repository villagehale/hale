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
import { users } from './users.js';

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
    /** How the activity recurs — "seasonal" | "one-time" | "ongoing". Nullable:
     * pre-cadence rows and unclassified candidates stay null (no chip). Free text
     * (not a DB enum) so the model's label lands without a migration to extend. */
    cadence: text('cadence'),
    summary: text('summary').notNull(),
    sourceUrl: text('source_url'),
    /** Which discovery provider produced this row (e.g. "fake", "web_grounded"). */
    source: text('source').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    /** Coarse, human-readable coverage note (e.g. "serves your area"); never precise. */
    coverageNote: text('coverage_note'),
    /** PUBLIC venue coordinates (e.g. a YMCA, a library) resolved from the
     * candidate's title + the family's COARSE area via Places Text Search — these
     * are public-place locations, NOT the family's location (rule #1). All
     * nullable: online / no-venue activities and geocode misses stay list-only
     * (no pin). The family's precise home is never stored here or anywhere. */
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    venueName: text('venue_name'),
    venueAddress: text('venue_address'),
    /** Opaque token for a public, read-only share of THIS single candidate (the
     * per-activity viral card at /a/:token). Nullable: minted only when a parent
     * opts to share this one pick. UNIQUE so the token alone resolves the row. It
     * carries no child or parent identity. */
    shareToken: text('share_token').unique(),
    /** Calendar date of a one-time (or dated seasonal) event, so the feed can
     * drop events already in the past. Null for ongoing options and anything the
     * source did not date — the model never fabricates one (rule: honest sourcing). */
    eventDate: date('event_date'),
    /** Which seasons a seasonal activity runs — a set drawn from
     * 'spring'|'summer'|'fall'|'winter' — so the feed can hide out-of-season
     * candidates. Null for one-time/ongoing and unclassified rows. */
    seasons: text('seasons').array(),
    /** Stamped when a newer discovery run replaces this family's set: the row is
     * soft-retired (the live feed filters superseded_at IS NULL) rather than
     * hard-deleted, so an endorsed / shared candidate survives for its public
     * /a/:token page. Null = still part of the active set. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('village_candidates_family_idx').on(table.familyId),
  }),
);

/**
 * One family endorsing one village candidate — the trusted-parent signal that
 * turns AI-sourced discovery into HYBRID trust (AI-sourced + parent-endorsed).
 * The unique (candidate_id, family_id) index makes endorsing idempotent: a
 * family can endorse a candidate at most once, so the aggregate is a true count
 * of DISTINCT families.
 *
 * Privacy (rule #1): the only thing ever surfaced from this table is an AGGREGATE
 * count ("loved by N families near you") — never a family's identity. No name, no
 * display field, no per-family detail is stored or exposed.
 *
 * familyId / candidateId ON DELETE cascade: removing either parent removes the
 * endorsement, so a stale count can never outlive its row.
 */
export const villageEndorsements = pgTable(
  'village_endorsements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => villageCandidates.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The user who tapped endorse — for the audit trail (rule #6); never surfaced. */
    endorsedByUserId: uuid('endorsed_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateFamilyIdx: uniqueIndex('village_endorsements_candidate_family_idx').on(
      table.candidateId,
      table.familyId,
    ),
    candidateIdx: index('village_endorsements_candidate_idx').on(table.candidateId),
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
  /** The weekday the routine agent placed this item on ("monday"–"sunday").
   * Additive + optional: rows written before this field stay valid and read back
   * as undefined (no day chip), so no data migration is needed (rule #9). */
  day?: string;
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

/**
 * The materialized agent-ranked feed order for one family — one row per family
 * (family_id is the PK). The rank-recommendations agent (~25s) runs in the
 * BACKGROUND on the write events that change the candidate set, and stores the
 * decided order here; the home feed read is then a pure DB lookup, so the model
 * never runs in the request path.
 *
 * fingerprint = the candidate ids joined in their discovery order: an upsert
 * whose fingerprint matches the stored one short-circuits before any model call
 * (bounded spend, rule #7), so the agent re-runs only when the candidate set
 * actually changed. ordered_ids is the agent's permutation of those ids; the read
 * path reconciles it against the live candidates so a stale id is never rendered.
 */
export const villageFeedRank = pgTable('village_feed_rank', {
  familyId: uuid('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  orderedIds: jsonb('ordered_ids').$type<string[]>().notNull(),
  fingerprint: text('fingerprint').notNull(),
  modelUsed: text('model_used').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type VillageCandidate = typeof villageCandidates.$inferSelect;
export type NewVillageCandidate = typeof villageCandidates.$inferInsert;
export type RoutineProposal = typeof routineProposals.$inferSelect;
export type NewRoutineProposal = typeof routineProposals.$inferInsert;
export type VillageEndorsement = typeof villageEndorsements.$inferSelect;
export type NewVillageEndorsement = typeof villageEndorsements.$inferInsert;
export type VillageFeedRank = typeof villageFeedRank.$inferSelect;
export type NewVillageFeedRank = typeof villageFeedRank.$inferInsert;
