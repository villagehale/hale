import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { children } from './children.js';
import { civicSessions } from './civic.js';
import { families } from './families.js';

/**
 * Village intros v1 — the double-opt-in, activity-anchored introduction between two
 * Hale families.
 *
 * ONE ROW IS ONE PAIR, and that is the whole design. An intro is not something Hale
 * does TO a family; it is a thing that either happens between two households or does
 * not happen at all. Modelling it per-family would make "both said yes" a join over two
 * rows that can disagree, and the disagreeing state — one side told an intro is
 * happening, the other never asked — is precisely the failure this feature cannot have.
 * With one row, `both_accepted` is a fact about the row, not a conclusion drawn from
 * two.
 *
 * WHAT IS NOT HERE, deliberately. No names, no numbers, no addresses, no message
 * bodies. The row holds two family ids, the FSA they share, the stage band they
 * overlap on, each side's own anchor child, and each side's yes/no. Everything a
 * parent ever READS is composed at send time from their OWN family's rows — the card
 * that goes to family A is built entirely from family A's data plus the coarse fact
 * that some family nearby has a child in the same band (rule #1).
 *
 * ORDERED PAIR. `family_a_id < family_b_id` is a CHECK, not a convention, so "have
 * these two been paired before?" is one lookup rather than two, and the partial unique
 * index below can actually mean "at most one open proposal per pair". Without the
 * ordering the same pair could be stored twice in mirror order and both would be open.
 *
 * CLOSED IS FOREVER. `closed_at` is stamped on every terminal status
 * (both_accepted / declined / expired) and the row is never deleted: a declined pair
 * must stay findable so the matcher never re-proposes it, and a completed intro is a
 * cross-household DISCLOSURE that PIPEDA right-to-access has to be able to answer for
 * (rule #6 covers the audit rows; this row is what they point at).
 */

/** Where a proposal is in its life. Text, not a pg enum: the vocabulary is app-layer
 * policy that will move while the loop is tuned, and a CREATE TYPE per iteration buys
 * nothing the app does not already check (the civic tables' precedent). */
export type VillageIntroStatus = 'proposed' | 'both_accepted' | 'declined' | 'expired';

/** One side's answer to the coarse card. Null while unanswered — which is a real,
 * distinct state from 'no' and must never collapse into it. */
export type VillageIntroReply = 'yes' | 'no';

export const villageIntroProposals = pgTable(
  'village_intro_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Canadian forward sortation area both families share — the ONLY locality
     * grain this feature ever matches on (rule #1). Never a full postal code. */
    fsa: text('fsa').notNull(),
    status: text('status').notNull().$type<VillageIntroStatus>(),
    /** The FamilyStage band the two families overlap on, as derived at match time. */
    stage: text('stage').notNull(),
    /** The free civic session both families could be at, when one exists in their FSA.
     * Null is the normal case and means the card carries no activity anchor. ON DELETE
     * SET NULL: a superseded session must not delete a live proposal. */
    civicSessionId: uuid('civic_session_id').references(() => civicSessions.id, {
      onDelete: 'set null',
    }),

    familyAId: uuid('family_a_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    familyBId: uuid('family_b_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),

    /** Each side's OWN anchor child — the one their own card is worded around. Never
     * the other family's. Nullable via ON DELETE SET NULL so removing a child cannot
     * delete the pairing record; the sweep treats a null anchor as a proposal it can no
     * longer word and closes it rather than guessing a different child. */
    familyAChildId: uuid('family_a_child_id').references(() => children.id, {
      onDelete: 'set null',
    }),
    familyBChildId: uuid('family_b_child_id').references(() => children.id, {
      onDelete: 'set null',
    }),

    /** When each side's coarse card actually went out. Null = not asked yet, which is
     * what stops an hourly sweep asking twice, and what makes "this side was never
     * asked" distinguishable from "this side did not answer". */
    familyAAskedAt: timestamp('family_a_asked_at', { withTimezone: true }),
    familyBAskedAt: timestamp('family_b_asked_at', { withTimezone: true }),

    familyAReply: text('family_a_reply').$type<VillageIntroReply>(),
    familyBReply: text('family_b_reply').$type<VillageIntroReply>(),
    familyARepliedAt: timestamp('family_a_replied_at', { withTimezone: true }),
    familyBRepliedAt: timestamp('family_b_replied_at', { withTimezone: true }),

    /** Silence is an answer here. A card nobody replied to lapses rather than sitting
     * open forever, and the other side is told so without being told why. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orderedPair: check('village_intro_proposals_ordered_pair', sql`${table.familyAId} < ${table.familyBId}`),
    openPairUniq: uniqueIndex('village_intro_proposals_open_pair_idx')
      .on(table.familyAId, table.familyBId)
      .where(sql`${table.closedAt} IS NULL`),
    familyAIdx: index('village_intro_proposals_family_a_idx').on(table.familyAId),
    familyBIdx: index('village_intro_proposals_family_b_idx').on(table.familyBId),
    fsaStatusIdx: index('village_intro_proposals_fsa_status_idx').on(table.fsa, table.status),
  }),
);

export type VillageIntroProposal = typeof villageIntroProposals.$inferSelect;
export type NewVillageIntroProposal = typeof villageIntroProposals.$inferInsert;
