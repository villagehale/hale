import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-304 · THE MENU HALE JUST PUT IN FRONT OF A PARENT.
 *
 * When more than one thing is open and a parent's answer names none of them, Hale asks
 * which — and until this table, that sentence was the only trace of it. The options went
 * out over the carrier and were forgotten in the same breath, so the reply that came
 * back thirty seconds later was read cold against every open question at once. On
 * 2026-08-24 a parent quoted one of the offered options back VERBATIM and reached the
 * general coach lane, which answered that it cannot message other families. The option
 * was real, the answer was exact, and there was nowhere for it to land.
 *
 * THIS IS NOT A SECOND REGISTRY OF OPEN QUESTIONS, and the distinction is the whole
 * reason it may exist at all (see the standing prohibition in
 * lib/channel/router/open-questions.ts). It records a MESSAGE HALE SENT — which options
 * were named, in which order, whether they were numbered — and nothing about whether any
 * of them is still open. That question has exactly one reader, the module that owns each
 * kind, and the matcher re-asks it on the way past: an option whose question has closed
 * cannot be chosen, however plainly it was named.
 *
 * ONE SHOT, AND IT IS SPENT ON THE WAY PAST. `consumed_at` is stamped by the next inbound
 * from that parent whatever that inbound turns out to be — the discipline M7's `reasked_at`
 * keeps for the same reason. A menu that could be answered twice is a menu that answers a
 * later, unrelated text.
 *
 * RULE #1. `options` carries Hale's own printed phrases — an action TYPE label, "the plan
 * I offered", "sending your welcome note to the new family" — which is exactly what the
 * parent already read on their phone (open-questions.ts `subject`). No payload, no other
 * household, and never the parent's own words.
 */
export const pendingDisambiguations = pgTable(
  'pending_disambiguations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /**
     * WHOSE menu. Per parent rather than per family: two parents share every open
     * question and answer them in two separate threads, so a co-parent's "the second one"
     * must never be read against a list the OTHER parent was shown.
     *
     * A real foreign key with its own cascade. Family erasure already reaches this row,
     * but a user removed from a household is a row nothing would otherwise collect
     * (the user-scoped-rows gap).
     */
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The outbound `channel_messages` row that carried the question — NOT NULL, the same
     * send-time discipline every MEM-10 writer keeps (agent_commitments.created_from). A
     * clarifier that never reached a transport asked nobody anything, so it may not bind
     * the next reply.
     */
    askedFrom: text('asked_from').notNull(),
    /**
     * The yes or no the parent had ALREADY given, before Hale asked which one it was
     * about. Carried because the clarifier asks WHICH, never WHETHER: re-deciding the
     * polarity off a reply that only names a target would turn "no thanks" plus "the
     * calendar one" into a calendar write nobody consented to (rule #4).
     */
    polarity: text('polarity').notNull(),
    /**
     * Whether the sentence that went out actually PRINTED 1, 2, 3.
     *
     * The canned choice sentence numbers its options (router/copy.ts); a coach that asked
     * in its own words did not. An ordinal is only an answer to a list the parent was
     * shown, so this is what stops "2" being read against a menu that never had a 2 in it.
     */
    numbered: boolean('numbered').notNull(),
    /** The options as they were printed, in printed order. Hale's own phrases (rule #1). */
    options: jsonb('options').$type<PendingDisambiguationOption[]>().notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the next inbound spent it. Null is the only state in which it can be answered. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => ({
    // A polarity is one of two words. Free text here would be a consent decision nobody
    // can read back, so the DATABASE says which two.
    polarityCheck: check(
      'pending_disambiguations_polarity_check',
      sql`${table.polarity} IN ('yes', 'no')`,
    ),
    // AT MOST ONE live menu per parent, and it is also the supersede anchor: a second
    // clarifier conflicts here and takes the row over rather than leaving two lists a
    // reply could be read against.
    liveUniq: uniqueIndex('pending_disambiguations_live_uniq')
      .on(table.parentUserId)
      .where(sql`${table.consumedAt} IS NULL`),
  }),
);

/**
 * One printed option, bound to the question it names.
 *
 * `questionId` is the owning row's own id (open-questions.ts) and never a position: a
 * list can be renumbered between the message and the answer, and an id cannot. The
 * ordinal lives in the ARRAY ORDER, which is the order the sentence printed.
 */
export interface PendingDisambiguationOption {
  questionId: string;
  kind: string;
  /** The phrase Hale printed for it — what the parent may quote back. */
  subject: string;
}

export type PendingDisambiguationRow = typeof pendingDisambiguations.$inferSelect;
