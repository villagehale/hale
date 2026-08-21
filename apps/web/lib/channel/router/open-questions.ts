import type { Database } from '@hale/db';
import { actionTypeLabel } from '~/lib/format/labels';
// Type-only, so the cycle with approval.ts (which imports `approvalSubjects` from here)
// is erased at build time. One shape for a drafted action, owned by the spine that reads
// them, rather than a structural copy the two files could drift apart on.
import type { PendingAction } from './approval';
import { MAX_LISTED_APPROVALS } from './fast-path';

/**
 * WHAT HALE IS CURRENTLY WAITING TO HEAR BACK ABOUT — every open question, derived.
 *
 * THERE IS NO REGISTRY TABLE AND THERE MUST NOT BE ONE. Every question below is already
 * implied by state some module owns: a drafted action IS the approval question, an
 * un-answered proposal row IS the intro question, an open `plan_offer` commitment IS the
 * plan question. A second table listing them would be a second answer to "is this still
 * open", and the two would disagree the first time a co-parent answered something in the
 * app. So this module OWNS NO STATE; it asks the modules that do and puts their answers
 * in one shape.
 *
 * WHY IT EXISTS AT ALL. A parent who is handed a keyword can be understood by a string
 * comparison. A parent who is allowed to answer in their own words can only be understood
 * against the questions actually outstanding — "yeah go ahead" means nothing in the
 * abstract and means one specific thing when exactly one thing is pending. This list is
 * what makes that reading possible, and it is also the cost control: no open question, no
 * model call (see resolve.ts).
 *
 * WHAT MAY BE IN A DESCRIPTION (rule #1). Only what HALE ITSELF put in the message it
 * sent — an action TYPE label, never a payload; the fact that an introduction is pending,
 * never who with. The descriptions go to a model, so the rule is the strictest reading:
 * nothing about another household, and nothing about this one that Hale did not already
 * text them.
 */

/**
 * The questions a parent can answer YES or NO to.
 *
 * Deliberately NOT every open thread Hale has. Three are missing and all for one reason:
 * their answer is not a polarity, so a stage that returns yes/no could only mis-answer
 * them.
 *
 *   · The IDENTITY gap-fills want a value — "yes" is not an email address. They keep their
 *     own shape-matching handlers, which read an address or a name from any wording at all
 *     and never needed a model.
 *   · The REGISTRATION check-in wants one of three outcomes ("we got in", "waitlisted
 *     #3", "missed it"), and M7 already hands anything it cannot read to the coach.
 *   · The HEALTH checkpoint's DONE half is still missing, and for the original reason: the
 *     nudge asks two things at once ("Done, or want me to add booking it to your week?"),
 *     and "yes" to the first half is genuinely unreadable — filing a checkpoint as done
 *     writes a permanent suppression and the parent never hears about that errand again.
 *     The exact-word handler still reads "done", "did it", a tick — all free, all
 *     unchanged.
 *
 * Its OFFER half, though, is now here as `checkup_offer`, and removing it was the bug
 * (2026-08-20). "Want me to add booking it to your week?" is an offer with one polarity
 * and a real writer behind it, and a parent who accepted it had their acceptance read
 * against two unrelated standing questions instead. What made it listable is that the
 * nudge now WRITES THE OFFER DOWN at send time (lib/health/offer.ts) — the question is a
 * ledger row like every other one on this list, not a fact inferred from the last message
 * Hale happened to send.
 */
export type OpenQuestionKind =
  | 'approval'
  | 'intro_optin'
  | 'intro_proposal'
  | 'plan_offer'
  | 'checkup_offer'
  | 'activity_followup';

/**
 * How much certainty an answer to this class needs before it is acted on.
 *
 * `consequential` is D17's line drawn in code: a cross-household DISCLOSURE and a change
 * to a real calendar are the two answers whose wrong reading cannot be shrugged off, so
 * they need the resolver to be sure AND to have named which question it is sure about.
 * `ordinary` covers the answers whose wrong reading costs a message nobody wanted.
 */
export type QuestionGrade = 'consequential' | 'ordinary';

const GRADE: Record<OpenQuestionKind, QuestionGrade> = {
  // Executes something the parent cannot see and needs an undo.
  approval: 'consequential',
  // Discloses a household to another household.
  intro_proposal: 'consequential',
  // Turns discoverability on. Nothing is shared by it, and it is revocable in a sentence.
  intro_optin: 'ordinary',
  // Three texts of parenting advice.
  plan_offer: 'ordinary',
  // Drafts an appointment reminder and holds it for approval. Nothing is executed and
  // nothing is disclosed, so a wrong reading costs one draft the parent can decline.
  checkup_offer: 'ordinary',
  // Never reached — nothing resolves an activity promise (see KIND_ANSWERABLE). The
  // Record forces a choice anyway, and `ordinary` is the honest one: if a polarity ever
  // did get somewhere to go, the worst it could cost is one text nobody wanted.
  activity_followup: 'ordinary',
};

export function questionGrade(kind: OpenQuestionKind): QuestionGrade {
  return GRADE[kind];
}

/** Polarities a question of this CLASS could have somewhere to put. A `no` to an offer
 * has no writer — the offer simply lapses — so a resolver-no there is not an answer this
 * system can record, and the turn goes to the coach, which can say something true. */
const KIND_ANSWERABLE: Record<OpenQuestionKind, Answerable> = {
  approval: { yes: true, no: true },
  intro_optin: { yes: true, no: true },
  intro_proposal: { yes: true, no: true },
  plan_offer: { yes: true, no: false },
  checkup_offer: { yes: true, no: false },
  // NEITHER POLARITY, and this is the one entry on the list that is not a question.
  //
  // An activity promise is Hale saying "I'll come back to you", which asks for nothing:
  // there is no yes that makes it more true and no no that has a writer, and the sweep
  // discharges it whatever the parent does. It is LISTED anyway, because the list is
  // what `soleOpenKind` reads to decide whether a bare "yes" is ambiguous — and on
  // 2026-08-20 a parent's "Yes, please", said while Hale was holding exactly this kind of
  // promise, was claimed by an unrelated flagged calendar draft and answered with a line
  // about Hale's own review. A promise Hale is holding makes a bare affirmative
  // ambiguous, whether or not it is the thing being answered, so the honest reading is to
  // list it and let the turn fall through to the coach — which is handed the subject and
  // can say something true about it.
  activity_followup: { yes: false, no: false },
};

export interface Answerable {
  yes: boolean;
  no: boolean;
}

/**
 * WHICH POLARITIES THIS PARTICULAR QUESTION CAN TAKE, RIGHT NOW.
 *
 * Per-question rather than per-class, and that is the second half of the 2026-08-20 fix.
 * A drafted action that has not cleared the reviewer (rule #3) is a real open question —
 * the parent can still say "drop it" — but its YES is refused by `approveDraftedAction`
 * whatever the parent says. Listing it as yes-answerable meant the resolver could bind an
 * acceptance to a row the mutator was always going to refuse, and the parent got a
 * sentence about Hale's internal review in place of an answer.
 *
 * So answerability is READ OFF THE ROW, at the one place the rows are read. A question
 * whose polarity has nowhere to go never resolves (resolve.ts returns `not_answerable`),
 * and the turn goes to the coach, which can say something true about it.
 */
export function answerable(question: OpenQuestion, polarity: 'yes' | 'no'): boolean {
  return question.answerable[polarity];
}

export interface OpenQuestion {
  /**
   * Stable, and stable across the two reads this turn makes of it: the row's own id where
   * a row exists (an action, a proposal, a commitment), and a derived key where the
   * question is the ABSENCE of a row. Never an ordinal — a position in a list can be
   * renumbered between the message and the answer, and an id cannot.
   */
  id: string;
  kind: OpenQuestionKind;
  /** One neutral line, from Hale's own ask — what the RESOLVER is shown. */
  description: string;
  /**
   * The same question as a short noun phrase, for the one sentence a PARENT may read
   * ("Which one - the swim class move, or meeting the family nearby?").
   *
   * A second field rather than a reused one because the two readers want opposite things.
   * A model reads better with a full line; a text message reads worse with one, and
   * splicing "A student vaccine record check is due on ICON." into a list of choices
   * produces a sentence no person would send. Both are Hale's own words either way.
   */
  subject: string;
  /** What answering it could actually DO, read off the row — see {@link answerable}. */
  answerable: Answerable;
}

/**
 * The printable phrase per class. Fixed, except for approvals — a family can have three
 * drafted changes open at once and telling them apart is the entire point of the
 * question, so those carry the action's own label instead.
 */
const SUBJECT: Record<Exclude<OpenQuestionKind, 'approval'>, string> = {
  intro_optin: 'introductions to other Hale families nearby',
  intro_proposal: 'meeting the family nearby',
  plan_offer: 'the plan I offered',
  checkup_offer: 'booking that visit',
  activity_followup: 'what I said I would come back to you about',
};

/**
 * MAY A BARE AFFIRMATIVE EXECUTE THIS KIND, RIGHT NOW?
 *
 * Only when every open question is of that one kind. This is the approvals module's own
 * first decision — "an ambiguous affirmative never executes" — finally applied across all
 * of them instead of within one.
 *
 * IT BECAME NECESSARY THE MOMENT THE ASKS STOPPED PRINTING KEYWORDS. The intro card used
 * to end "Reply YES INTRO", and that two-word answer is what kept a bare "yes" out of the
 * intro question entirely — the approvals grammar could own every bare affirmative safely
 * precisely because the intro lane had its own vocabulary. Composing the card removed the
 * disambiguator and left the priority rule behind it, so a parent answering "Want me to
 * introduce you?" with "yes" would have approved an unrelated calendar write. Consent
 * applied to the wrong question (rule #4), and no test caught it because every handler
 * still behaved exactly as documented.
 *
 * WHAT REPLACES THE PRIORITY RULE IS ASKING. The old order (approvals beat health beat
 * plans) was a tie-break invented when Hale had no way to ask which; it always resolved a
 * coin flip in favour of the most expensive wrong answer being possible. Now the turn
 * falls through to the resolver, which either recognises which question the words name or
 * returns `ambiguous` and Hale asks in one sentence. Slower by one round trip, and it
 * cannot execute the wrong thing.
 *
 * An ORDINAL is exempt and is not routed here: "yes 2" cannot be conversation and cannot
 * be an answer to anything but a numbered list.
 *
 * `kind: null` is for a handler that owns no TRACKED question. Nothing in the shipped
 * chain passes it any more — the health checkpoint was the last one, and its offer half is
 * now a listed kind — but it stays because it is the correct reading for a handler that
 * claims a bare word off state this module does not model: any open question at all makes
 * that word ambiguous for it.
 *
 * An EMPTY list is vacuously true, and that is the correct reading rather than a
 * convenience: with nothing outstanding there is nothing for a bare "yes" to be ambiguous
 * WITH, and each handler still has to find something of its own to act on.
 */
export function soleOpenKind(
  questions: readonly OpenQuestion[],
  kind: OpenQuestionKind | null,
): boolean {
  return questions.every((question) => question.kind === kind);
}

export interface OpenQuestionReader {
  open(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<OpenQuestion[]>;
}

/**
 * The per-kind readers, injected — each one the function the OWNING module already
 * exports, so this file adds no second opinion about whether anything is open.
 */
export interface OpenQuestionSources {
  /** The approvals spine's own pending list, oldest first. */
  pendingApprovals(database: Database, familyId: string): Promise<PendingAction[]>;
  /** True when the discoverability ask was delivered and carries no answer yet. */
  introOptInOpen(
    database: Database,
    input: { familyId: string; parentUserId: string },
  ): Promise<boolean>;
  /** The proposal this family may answer right now, or null. */
  introProposal(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string } | null>;
  /** The live, unexpired plan offer, or null. */
  planOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string; summary: string } | null>;
  /** The live, unexpired health-checkpoint booking offer, or null. */
  checkupOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string; summary: string } | null>;
  /**
   * The activity follow-up Hale still owes this family, or null.
   *
   * NO `now`, unlike the two offers, and the omission is deliberate: they stop being
   * ANSWERABLE when their moment passes, while a promise does not stop being OWED by
   * getting late. It stays here until the sweep keeps it or a cancellation voids it.
   */
  activityPromise(
    database: Database,
    familyId: string,
  ): Promise<{ id: string; summary: string } | null>;
}

/**
 * Every open question, read in parallel.
 *
 * APPROVALS ARE LISTED INDIVIDUALLY, up to the same ceiling a numbered list used to print.
 * They have to be: with two drafted changes open, "yes to the swim one" is only resolvable
 * if the swim one is a thing that can be named. The ceiling is {@link MAX_LISTED_APPROVALS}
 * and comes from the same constant the ordinal grammar reads, so a question the resolver
 * can be told about is exactly a question a parent could have been shown.
 *
 * A FAILING READER IS NOT AN EMPTY LIST. It throws, and the turn defers into the queue's
 * own backoff, because "no questions are open" is the answer that sends a parent's yes to
 * the coach — and a coach that has been told nothing is pending will say so.
 */
export function createOpenQuestionReader(sources: OpenQuestionSources): OpenQuestionReader {
  return {
    async open(database, input) {
      const [approvals, optIn, proposal, offer, checkup, promise] = await Promise.all([
        sources.pendingApprovals(database, input.familyId),
        sources.introOptInOpen(database, {
          familyId: input.familyId,
          parentUserId: input.parentUserId,
        }),
        sources.introProposal(database, input.familyId, input.now),
        sources.planOffer(database, input.familyId, input.now),
        sources.checkupOffer(database, input.familyId, input.now),
        sources.activityPromise(database, input.familyId),
      ]);

      const questions: OpenQuestion[] = namedApprovals(approvals).slice(
        0,
        MAX_LISTED_APPROVALS,
      );

      if (optIn) {
        questions.push({
          id: introOptInQuestionId(input.familyId),
          kind: 'intro_optin',
          description: 'Whether to be introduced to other Hale families nearby',
          subject: SUBJECT.intro_optin,
          answerable: KIND_ANSWERABLE.intro_optin,
        });
      }
      if (proposal) {
        questions.push({
          id: proposal.id,
          kind: 'intro_proposal',
          // Not one fact about the other household — the same rule the card itself keeps.
          description: 'Whether to meet one nearby Hale family',
          subject: SUBJECT.intro_proposal,
          answerable: KIND_ANSWERABLE.intro_proposal,
        });
      }
      if (offer) {
        // The commitment's own `summary`, which the ledger's contract already requires to
        // be one short parent-safe sentence with no child detail.
        questions.push({
          id: offer.id,
          kind: 'plan_offer',
          description: offer.summary,
          subject: SUBJECT.plan_offer,
          answerable: KIND_ANSWERABLE.plan_offer,
        });
      }
      if (checkup) {
        // The same contract, from the same ledger: one short parent-safe sentence built
        // from the reviewed checkpoint's own task (lib/health/offer.ts).
        questions.push({
          id: checkup.id,
          kind: 'checkup_offer',
          description: checkup.summary,
          subject: SUBJECT.checkup_offer,
          answerable: KIND_ANSWERABLE.checkup_offer,
        });
      }
      if (promise) {
        // The commitment's own `summary` again — one short parent-safe sentence, the
        // ledger's contract for every row on it.
        questions.push({
          id: promise.id,
          kind: 'activity_followup',
          description: promise.summary,
          subject: SUBJECT.activity_followup,
          answerable: KIND_ANSWERABLE.activity_followup,
        });
      }
      return questions;
    },
  };
}

/**
 * The drafted actions, each named by something a parent could actually pick out.
 *
 * THE TYPE LABEL AND NEVER THE PAYLOAD. A drafted action can be a teenager's, and
 * `actionTypeLabel` is derived from the type alone (rule #1, format/labels.ts).
 *
 * WHICH IS WHY DUPLICATES HAPPEN. Two calendar additions are two different changes with
 * one label, and "Which one - add to your calendar, or add to your calendar?" is not a
 * question. The numbered menu this replaced did not have that problem, and dropping the
 * menu without replacing what it did would have moved a dead end rather than removed one.
 * So a label that repeats gets its POSITION in the same oldest-first list the ordinal
 * grammar resolves against — as a description ("the first"), not as an instruction
 * ("YES 1"). A parent says "the first one" and it resolves; "yes 1" also still resolves,
 * because no read was removed.
 *
 * A label that does not repeat is left completely alone, which is the common case.
 *
 * A DRAFT THAT HAS NOT CLEARED THE REVIEWER IS STILL A QUESTION, and it is still listed —
 * the parent can say "drop that one" and `declineDraftedAction` will do it. What it is
 * not is ACCEPTABLE: `approveDraftedAction` refuses any draft whose verdict is not
 * `approved` (rule #3), so its yes is marked closed here and the resolver will not bind an
 * acceptance to it (2026-08-20: it did, and the parent was answered with a sentence about
 * Hale's own review instead).
 */
function namedApprovals(approvals: ReadonlyArray<PendingAction>): OpenQuestion[] {
  // Names EVERY pending action and lets each caller take what it can show. The two
  // callers cut the list at the same ceiling but they cut it at different moments (one
  // before sending it to a model, one while writing a sentence with an overflow count),
  // and slicing here would silently zero that count.
  const labels = approvals.map((action) => actionTypeLabel(action.actionType));
  return approvals.map((action, index) => {
    const label = labels[index] as string;
    const duplicated = labels.filter((other) => other === label).length > 1;
    const position = duplicated ? ` (the ${ORDINAL_WORD[index] ?? `${index + 1}`})` : '';
    return {
      id: action.actionId,
      kind: 'approval' as const,
      description: `${label}${position}`,
      subject: `${label.toLowerCase()}${position}`,
      answerable: { yes: action.reviewerApproved, no: true },
    };
  });
}

/** Only as many as a list can hold — {@link MAX_LISTED_APPROVALS} is 3. */
const ORDINAL_WORD = ['first', 'second', 'third'];

/**
 * The same names, for the clarifying sentence the APPROVAL grammar sends when a bare
 * "yes" arrives with several drafts pending.
 *
 * One namer, two callers, deliberately: the question Hale prints and the question the
 * resolver is shown have to be the same question, or a parent answers "the second one"
 * about a list that was numbered differently behind the scenes.
 */
export function approvalSubjects(pending: ReadonlyArray<PendingAction>): string[] {
  return namedApprovals(pending).map((question) => question.subject);
}

/** The opt-in question is an ABSENCE — a delivered ask with no consent row behind it — so
 * it has no row id of its own and gets a derived one. Exported because the applier reads
 * it back to know which question was answered. */
export function introOptInQuestionId(familyId: string): string {
  return `intro_optin:${familyId}`;
}
