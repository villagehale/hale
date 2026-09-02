import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { matchPhrase, normalizeReply, readAffirmative } from '~/lib/channel/affirmative';
import { matchFastPath } from './fast-path';
import { type OpenQuestion, type OpenQuestionKind, answerable } from './open-questions';

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
 * `no_target` — the coach lane — no matter how sure the model was about which one. That
 * is correct in general and exactly wrong for the thirty seconds after Hale asked a
 * parent to pick. This module is that exception, and it is deliberately NOT a model:
 * choosing between options Hale itself printed is a string comparison, and a free one.
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

export type DisambiguationOutcome =
  /** They picked one, and it can still be answered. */
  | { status: 'chosen'; option: DisambiguationOption; polarity: 'yes' | 'no' }
  /** They did not, and WHY is named rather than collapsed (rule #11): each of these is a
   * different story about a parent, and the turn carries on to the ordinary router. */
  | {
      status: 'no_choice';
      reason:
        | 'nothing_open'
        | 'changed_their_mind'
        | 'ordinal_not_offered'
        | 'names_several'
        | 'not_a_choice';
    };

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
 * Words that cannot tell two options apart, dropped before anything is compared.
 *
 * Function words only. Nothing here carries a topic: "calendar", "welcome", "digest",
 * "swim" all survive, and it is those that do the choosing. Kept deliberately short —
 * every word removed is a word a parent could have used to pick, and the shared-word rule
 * below already neutralises anything two options have in common.
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  `the a an and or of to for in on at with from your my our their that this these those
   it its i me you we us they them is are was be do does did one ones just so if but not
   up out what which when where how why would will`.split(/\s+/),
);

/**
 * The words that REFUSE, scanned over the whole reply before anything is matched.
 *
 * "not the calendar one" names exactly one option and carries neither a yes nor a no, so
 * every guard in this module used to wave it through and hand the parent's standing YES
 * to the one thing they had just excluded — which the owning handler then executed
 * (verifier, 2026-08-26; rule #4). Two separate reasons it got that far, and they are why
 * this is a scan of its own rather than another word added to a list:
 *
 *   THE NEGATORS WERE STOPWORDS. 'not' and 'but' are function words, so the matcher
 *   dropped them before comparing — the one class of word whose whole job is to invert
 *   the sentence, deleted first.
 *
 *   THE POLARITY GUARD READS WORD BY WORD. It asks whether any single word IS a yes or a
 *   no (affirmative.ts's whole-string vocabulary, applied per token). 'not' is neither.
 *   'dont' happens to be in that vocabulary and so was caught; 'not', 'but', 'except',
 *   'never' and 'without' are not, and a guard that catches one spelling of a refusal and
 *   not the next four is not a guard.
 *
 * SCOPE IS DELIBERATELY THE WHOLE UTTERANCE rather than the words adjoining the match. A
 * negator anywhere means this sentence is doing something other than picking one thing off
 * a list — excluding, correcting, hedging — and none of those may resolve to consent. The
 * cost of being broad is a turn that goes to the coach, which can ask; the cost of being
 * narrow is an action nobody agreed to.
 *
 * French, for the reason affirmative.ts reads three languages: the identical sentence in
 * the identical shape must not be the one that gets through.
 */
const NEGATORS: ReadonlySet<string> = new Set(
  `not dont doesnt didnt cant cannot wont isnt arent never neither nor but except without
   pas sans sauf jamais`.split(/\s+/),
);

/**
 * Which option this reply picked, if any.
 *
 * Pure, and that is not incidental: every branch below is a decision about somebody's
 * consent, and a decision that can be read straight out of its inputs is one a test can
 * prove rather than approximate.
 */
export function matchDisambiguation(
  pending: PendingDisambiguation,
  body: string,
  open: readonly OpenQuestion[],
): DisambiguationOutcome {
  const polarity = pending.polarity;
  // Re-read live, and re-graded: an option whose question has closed, or that has stopped
  // being able to take THIS answer, is not a thing the parent can still choose. The list
  // Hale printed is what they read; what may act on it is the ledger's business.
  const live = pending.options.filter((option) => {
    const question = open.find((q) => q.id === option.questionId);
    return question !== undefined && answerable(question, polarity);
  });
  if (live.length === 0) return { status: 'no_choice', reason: 'nothing_open' };

  const words = normalizeReply(body).split(' ').filter(Boolean);
  // A REFUSAL IS NEVER A SELECTION, whatever else it names, and this runs before the
  // ordinal and before any word is compared. After a yes it is the parent contradicting
  // the answer on the row; after a no there is nothing left to read at all.
  if (words.some((word) => NEGATORS.has(word))) {
    return {
      status: 'no_choice',
      reason: polarity === 'yes' ? 'changed_their_mind' : 'not_a_choice',
    };
  }
  // The parent had already said yes or no; this sentence was only ever about WHICH. One
  // that carries the opposite word is not a selection at all, and reading it as one would
  // apply an acceptance to something they had just refused (rule #4).
  const stated = words.map(matchPhrase).find((verdict) => verdict !== 'unclear');
  if (stated !== undefined && stated !== polarity) {
    return { status: 'no_choice', reason: 'changed_their_mind' };
  }

  const ordinal = readOrdinal(body, words);
  if (ordinal !== null) {
    // A number is only an answer to a list somebody was SHOWN. A coach that asked in its
    // own words printed no numbers, so there is nothing here for "2" to point at.
    const option = pending.numbered ? pending.options[ordinal - 1] : undefined;
    return option !== undefined && live.includes(option)
      ? { status: 'chosen', option, polarity }
      : { status: 'no_choice', reason: 'ordinal_not_offered' };
  }

  // Everything but one closed itself between the question and the answer, so the bare
  // affirmative that was ambiguous a moment ago has stopped being ambiguous.
  if (live.length === 1 && readAffirmative(body) === polarity) {
    return { status: 'chosen', option: live[0] as DisambiguationOption, polarity };
  }

  const spoken = new Set(words);
  const distinctive = distinctiveWords(live);
  const named = live.filter((_, i) =>
    [...(distinctive[i] as Set<string>)].some((word) => spoken.has(word)),
  );
  if (named.length === 1)
    return { status: 'chosen', option: named[0] as DisambiguationOption, polarity };
  return {
    status: 'no_choice',
    reason: named.length === 0 ? 'not_a_choice' : 'names_several',
  };
}

/**
 * The words that belong to exactly ONE of the options on offer.
 *
 * A word two options share cannot choose between them, so it is dropped rather than
 * scored — which is what makes "the calendar one" a real answer when the alternative is a
 * welcome note, and no answer at all when the alternative is a second calendar change.
 * Computed over what is still LIVE rather than over what was printed, so an option that
 * closed stops blocking a word it used to share.
 */
function distinctiveWords(options: readonly DisambiguationOption[]): Array<Set<string>> {
  const perOption = options.map((option) => contentWords(option.subject));
  const shared = new Map<string, number>();
  for (const set of perOption) {
    for (const word of set) shared.set(word, (shared.get(word) ?? 0) + 1);
  }
  return perOption.map((set) => new Set([...set].filter((word) => shared.get(word) === 1)));
}

function contentWords(phrase: string): Set<string> {
  return new Set(
    normalizeReply(phrase)
      .split(' ')
      .filter((word) => word.length > 0 && !STOPWORDS.has(word)),
  );
}

/**
 * Is this reply a NUMBER — the shape a menu's ordinal comes back in?
 *
 * Asked by the router about a turn the menu did NOT place (an option that closed, a
 * position that was never printed), because the digit is spent either way. Hale's other
 * numbered list is the approvals queue, whose ordering has nothing to do with the menu
 * this parent just read, and letting the same character fall through to it approves an
 * action they were never shown (verifier, 2026-08-26; rule #4). One reader per question:
 * the shape is decided here, by the same function the match itself uses.
 */
export function readsAsOrdinal(body: string): boolean {
  const words = normalizeReply(body).split(' ').filter(Boolean);
  return readOrdinal(body, words) !== null;
}

/**
 * The number this reply is, or null.
 *
 * Two shapes and no more: the bare digit, and the approval grammar's own "yes 2" (which
 * already refuses an ordinal outside the range a list can print). Anything looser would
 * start reading numbers out of sentences, and a sentence with a number in it is a
 * sentence, not a choice.
 */
function readOrdinal(body: string, words: readonly string[]): number | null {
  const command = matchFastPath(body);
  if (command?.index != null) return command.index;
  const only = words.length === 1 ? (words[0] as string) : null;
  return only !== null && /^\d+$/.test(only) ? Number.parseInt(only, 10) : null;
}

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
  consume(
    database: Database,
    input: { id: string; now: Date },
  ): Promise<'spent' | 'already_spent'>;
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
