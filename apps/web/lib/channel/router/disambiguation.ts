import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { OpenQuestionKind } from './open-questions';

/**
 * VIL-304 — WHEN HALE ASKS "WHICH ONE?", THE ASKING OWNS THE NEXT REPLY.
 *
 * A clarifier used to be a sentence and nothing else. Hale printed two or three options,
 * the carrier delivered them, and the fact that a specific short menu was now in front of
 * a specific parent existed nowhere. So the answer came back into a router with no memory
 * of the question: read cold, against every open question at once, by a stage built to
 * find a YES or a NO. On 2026-08-24 the founder quoted an option back word for word —
 * "sending your welcome note to the new family" — and got the general coach, which
 * correctly said it cannot message another household. The one door that could have sent
 * that note is the deterministic one, and nothing pointed at it.
 *
 * NAMING ONE OF A LIST IS NOT A YES/NO QUESTION, which is the deeper half of it.
 * `toReading` gates on polarity BEFORE target (resolve.ts, pinned by resolve.test.ts), so
 * a reply that names its target perfectly and contains no yes or no at all reads as
 * `no_target` — the coach lane — no matter how sure the model was about which one.
 * The model places which question the words mean. This module only remembers the
 * menu that was printed, so a later text is not still an answer to it.
 *
 * THREE THINGS KEEP IT SAFE, and each of them is the reason a whole class of wrong answer
 * is unreachable rather than unlikely:
 *
 *   THE POLARITY IS NOT RE-DECIDED. The clarifier asked WHICH, never WHETHER. The yes or
 *   no came from the message before it, and it travels on the row. A parent who now says
 *   the opposite is not picking from a list — they changed their mind, and that turn goes
 *   to the coach rather than being read as consent to the thing they just refused
 *   (rule #4).
 *
 *   THE QUESTION MUST STILL BE OPEN, re-read live through its owning module. This table
 *   remembers what Hale SAID, never what is outstanding — there is one reader for that
 *   and it is not here (open-questions.ts).
 *
 *   A WORD ONLY COUNTS IF IT NAMES EXACTLY ONE OPTION. Words shared by two options are
 *   worthless for telling them apart, so they are dropped from the comparison outright —
 *   which is why "the calendar one" resolves against a welcome note and does nothing at
 *   all against two calendar changes. Nothing is inferred from a near match, the same
 *   discipline `toReading` keeps for ids.
 */

/** One option exactly as it was printed, bound to the question it named. */
export interface DisambiguationOption {
  /** The owning row's own id (open-questions.ts). Never a position. */
  questionId: string;
  kind: OpenQuestionKind;
  /** The phrase Hale printed — the words a parent may quote back. */
  subject: string;
}

/** The menu still standing in front of this parent. */
export interface PendingDisambiguation {
  id: string;
  /** The answer the parent had already given, before Hale asked which one it was about. */
  polarity: 'yes' | 'no';
  /** Whether the sentence that went out actually printed 1, 2, 3. */
  numbered: boolean;
  /** In printed order — the ordinal IS the position. */
  options: readonly DisambiguationOption[];
}

/** Whether the menu got written down. `not_minted` is degraded, not broken: the question
 * still went out, and its answer takes the ordinary route. */
export type DisambiguationMintOutcome =
  | { status: 'minted' }
  | { status: 'not_minted'; reason: 'write_failed' };

/**
 * HOW LONG A MENU STANDS.
 *
 * Three hours: long enough for a parent who put the phone down mid-question, short enough
 * that tomorrow morning's text is a fresh conversation rather than an answer to something
 * they have forgotten being asked. It is a backstop rather than the guard — the menu is
 * spent by the very next inbound whatever it says, and every option is re-checked against
 * its own live row — so this only governs the parent who goes quiet and then says
 * something that happens to use one of Hale's words.
 */
export const DISAMBIGUATION_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * The menu's memory. Injected (rule #11): a router holding no store would go on asking
 * "which one?" and go on failing to hear the answer, which is precisely the defect this
 * closes — and it would do it invisibly, because every turn would still look like a
 * perfectly ordinary coach turn.
 */
export interface DisambiguationStore {
  /** The live, unspent, unexpired menu for this parent, or null. */
  pending(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<PendingDisambiguation | null>;
  /**
   * Write the menu down, against the message that carried it — the send-time discipline
   * every MEM-10 writer keeps. A clarifier that never reached a transport asked nobody
   * anything.
   *
   * NEVER THROWS, and its failure is a NAMED outcome rather than an exception (rule #11),
   * for the reason every send-time writer in this router keeps that contract: the parent
   * already has the message, so an exception here buys a carrier retry and a duplicate
   * question. What it must not do is fail quietly — a menu that was asked and not written
   * down is precisely the defect this module exists to close.
   */
  mint(
    database: Database,
    input: {
      familyId: string;
      parentUserId: string;
      channelMessageId: string;
      polarity: 'yes' | 'no';
      numbered: boolean;
      options: readonly DisambiguationOption[];
      now: Date;
    },
  ): Promise<DisambiguationMintOutcome>;
  /**
   * Spend it, and SAY WHETHER THIS CALL IS THE ONE THAT SPENT IT.
   *
   * One-shot is the property that stops a menu answering a later, unrelated text, and it
   * used to rest entirely on the queue handing one parent's inbounds over one at a time —
   * a fact about the enqueue, not about this table, and therefore one an unrelated change
   * to the drain could take away silently. So the spend states it itself: the UPDATE
   * matches only a row nobody has spent, and a caller that matched nothing is TOLD
   * (rule #11) rather than carrying on as though it had won the race.
   */
  consume(database: Database, input: { id: string; now: Date }): Promise<'spent' | 'already_spent'>;
}

export function createDisambiguationStore(): DisambiguationStore {
  return {
    async pending(database, { familyId, parentUserId, now }) {
      const [row] = await database
        .select({
          id: schema.pendingDisambiguations.id,
          polarity: schema.pendingDisambiguations.polarity,
          numbered: schema.pendingDisambiguations.numbered,
          options: schema.pendingDisambiguations.options,
        })
        .from(schema.pendingDisambiguations)
        .where(
          and(
            eq(schema.pendingDisambiguations.familyId, familyId),
            eq(schema.pendingDisambiguations.parentUserId, parentUserId),
            isNull(schema.pendingDisambiguations.consumedAt),
            gt(
              schema.pendingDisambiguations.askedAt,
              new Date(now.getTime() - DISAMBIGUATION_TTL_MS),
            ),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        polarity: row.polarity === 'no' ? 'no' : 'yes',
        numbered: row.numbered,
        options: row.options as DisambiguationOption[],
      };
    },

    async mint(database, input) {
      const values = {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        askedFrom: input.channelMessageId,
        polarity: input.polarity,
        numbered: input.numbered,
        options: [...input.options],
        askedAt: input.now,
        consumedAt: null,
      };
      try {
        // SUPERSEDES rather than accumulates: a second clarifier means the first list is
        // no longer what is in front of this parent, and two live lists would be two
        // things one reply could be read against.
        await database
          .insert(schema.pendingDisambiguations)
          .values(values)
          .onConflictDoUpdate({
            target: schema.pendingDisambiguations.parentUserId,
            targetWhere: isNull(schema.pendingDisambiguations.consumedAt),
            set: values,
          });
        return { status: 'minted' };
      } catch (err) {
        console.error(
          { err, familyId: input.familyId },
          'disambiguation: the menu could not be written down - the answer to it will reach the coach',
        );
        return { status: 'not_minted', reason: 'write_failed' };
      }
    },

    async consume(database, { id, now }) {
      const spent = await database
        .update(schema.pendingDisambiguations)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.pendingDisambiguations.id, id),
            isNull(schema.pendingDisambiguations.consumedAt),
          ),
        )
        .returning({ id: schema.pendingDisambiguations.id });
      return spent.length === 0 ? 'already_spent' : 'spent';
    },
  };
}
