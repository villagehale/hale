import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentCommitmentKindEnum } from './enums.js';
import { children } from './children.js';
import { families } from './families.js';

/**
 * MEM-10 · the OPEN-LOOPS LEDGER — Hale's own promises, as rows.
 *
 * When Hale tells a family "your first weekend find lands in a day or two" or "I will
 * send your plan the evening before", that sentence is a debt. Before this table exactly
 * one such debt was structural (the 48h nudge's own sweep); every other one was a hope
 * that the right cron would fire, and prose in a transcript that compaction is entitled
 * to summarize away. A promise that lives only in words cannot be counted, cannot be
 * shown to the parent, and cannot be seen to have been broken.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - a status column. Three timestamps say everything a status could, and they cannot
 *     disagree with each other the way a mirrored status disagrees with its source:
 *     OPEN is `fulfilled_at IS NULL AND cancelled_at IS NULL`, and OVERDUE is that plus
 *     `due_at < now()`. Overdue is therefore a QUERY, never a state something has to
 *     remember to write — no sweep can forget to mark a promise late.
 *   - the message body. `summary` is the promise in one short parent-safe sentence, and
 *     rule #1 is why: this row is read by an ops digest and (next) by the coach's own
 *     context, so it carries the commitment, never the thread's child detail.
 *   - a per-scope key. The partial unique index below says a family may owe at most ONE
 *     open promise of a kind at a time, which is what lets a fulfilling surface close
 *     "the first-find promise for this family" without inventing a correlation id.
 */
export const agentCommitments = pgTable(
  'agent_commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    commitmentKind: agentCommitmentKindEnum('commitment_kind').notNull(),
    /**
     * The outbound `channel_messages` row that carried the promise — NOT NULL, and that
     * is the whole send-time discipline (lib/health/told.ts's): a compose that never
     * reached a transport has no ledger row, so it cannot mint a debt. Text rather than
     * a uuid FK because provenance is all this column is for; erasure already cascades
     * from `families`, so a second foreign key buys nothing it does not already have.
     */
    createdFrom: text('created_from').notNull(),
    /** The promise in one short, parent-safe sentence. Rule #1: no child detail beyond
     * what the thread that made the promise already carried. */
    summary: text('summary').notNull(),
    /**
     * WHICH plan, for the kinds that have one — a member of the closed `PlanTopic`
     * vocabulary ('sleep', 'solids', 'potty', …) and never free text, never a parent's
     * words. Rule #1 holds because this is a CATEGORY, not content.
     *
     * Nullable because the first two kinds do not have a subject: there is exactly one
     * first find and one registration plan a family can be owed, so `commitment_kind`
     * alone names them. `plan_offer` is the first kind whose FULFILMENT needs a
     * parameter — a bare "YES" three days later has to resolve to the plan Hale
     * actually offered, and the check-in three days after that has to say which plan it
     * is asking about.
     *
     * Deliberately NOT recovered from `created_from`: that column is provenance only
     * (see its note), and making a sweep join back through a ledger row to learn a
     * category word would give the topic two homes that can disagree.
     */
    topic: text('topic'),
    /**
     * WHOSE plan, when the question was about one child. A real foreign key, unlike
     * `created_from`, because this id is looked UP rather than merely pointed at: the
     * composer grounds the plan on this child's age, and getting that wrong is the
     * difference between a plan and a plausible-sounding one.
     *
     * `set null` on delete: a child removed between the offer and the YES leaves a
     * household-scoped plan, which is a worse plan and an honest one — better than a
     * dangling id the composer would silently ground on nothing.
     */
    subjectChildId: uuid('subject_child_id').references(() => children.id, {
      onDelete: 'set null',
    }),
    /** When the promise stops being kept-in-time and starts being late. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    /** What closed it — the `channel_messages` id of the message that made good. Paired
     * with `fulfilled_at` by a check constraint, so "fulfilled by nothing" is unwritable. */
    fulfilledBy: text('fulfilled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Why the promise was voided rather than kept. Paired with `cancelled_at`: a
     * cancellation with no reason is a debt quietly deleted, which is the one closure a
     * ledger must never allow. */
    cancelledReason: text('cancelled_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A closure is always complete and always singular. Half of one ("fulfilled, by
    // nothing") would read back as a kept promise nobody can point at, and a row that is
    // both fulfilled AND cancelled has no answer to "did Hale do this?".
    closureCheck: check(
      'agent_commitments_closure_check',
      sql`(${table.fulfilledAt} IS NULL) = (${table.fulfilledBy} IS NULL)
          AND (${table.cancelledAt} IS NULL) = (${table.cancelledReason} IS NULL)
          AND NOT (${table.fulfilledAt} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL)`,
    ),
    // ONE open promise of a kind per family, as a constraint rather than a convention.
    // It is what makes closure addressable without a correlation id, and it is also the
    // idempotency anchor: a retried webhook or a double cron tick conflicts here instead
    // of minting a second debt for the same sentence.
    openKindUniq: uniqueIndex('agent_commitments_open_kind_uniq')
      .on(table.familyId, table.commitmentKind)
      .where(sql`${table.fulfilledAt} IS NULL AND ${table.cancelledAt} IS NULL`),
    // The overdue sweep's scan: the handful of promises still outstanding, by due time.
    openDueIdx: index('agent_commitments_open_due_idx')
      .on(table.dueAt)
      .where(sql`${table.fulfilledAt} IS NULL AND ${table.cancelledAt} IS NULL`),
    // Every promise Hale has made this family, newest first — the receipts read.
    familyIdx: index('agent_commitments_family_idx').on(table.familyId, table.createdAt),
  }),
);

export type AgentCommitment = typeof agentCommitments.$inferSelect;
export type NewAgentCommitment = typeof agentCommitments.$inferInsert;
