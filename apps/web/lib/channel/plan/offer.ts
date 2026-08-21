import { type RegisteredTool, defineTool } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { cancelCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { EXAMPLE_CHILD_ID } from '~/lib/coach/tools';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { PLAN_OFFER_TTL_HOURS, PLAN_TOPICS, type PlanTopic, planOfferSummary } from './topics';

/**
 * THE OFFER — step one of the full-plan arc.
 *
 * A parent asks a raising-kids question. The coach answers it in the two sentences the
 * channel affords (that part is unchanged and stays first), and then says the thing
 * this module exists for: there is a whole plan behind that answer, and one word
 * gets it.
 *
 * WHY THE TOOL DOES NOT WRITE THE ROW. `agent_commitments.created_from` is NOT NULL
 * against the outbound `channel_messages` row that CARRIED the promise, and at
 * tool-call time no message has been sent — the model is still composing the sentence
 * that will make the offer. So the tool REGISTERS an intent on the turn, exactly the
 * way `onDraft` reports a minted action, and the router writes the ledger row after
 * the transport accepts the reply. A turn that fails between the two makes no promise,
 * which is the correct outcome: nobody was offered anything.
 *
 * WHY THE TOPIC IS AN ENUM. It is persisted, and days later it selects the curated
 * PLAYBOOK the plan is grounded on. A free-text topic would mean a family's sleep plan
 * built from whichever playbook a fuzzy match happened to return.
 *
 * WHY THE OFFER SENTENCE IS AN ARGUMENT. It used to be a constant this module appended,
 * which was the fix for a real bug (the model wrote it, it landed last, and the segment
 * trim ate the half naming the magic word). But a constant is a preset body, and Hale
 * does not send those. So the model WRITES the offer and hands it in here, where it is
 * gated like any other outbound text — and a refusal throws a sentence the model reads
 * mid-turn, which makes the agent loop itself the recompose loop. No extra machinery,
 * no constant, and the trim still cannot touch it: the runtime appends the ACCEPTED
 * offer after fitting the answer around it.
 */

/** What the coach registered this turn: which plan it offered, about whom, and the
 * sentence it will be offered in — already gated. */
export interface PlanOffer {
  topic: PlanTopic;
  /** The child the question was about, when the parent named one. Null for a
   * question about the household, or an only child the model did not bother to name. */
  childId: string | null;
  /** The composed offer, verbatim as it will be sent. Protected from the reply trim. */
  sentence: string;
}

/** The offer sentence's own ceiling. One short SMS on top of an answer that already
 * costs two segments — anything longer and the answer is what gives way. */
export const MAX_OFFER_CHARS = 160;

/**
 * Everything wrong with a proposed offer sentence, phrased for the model that has to
 * rewrite it. An empty array means it may be sent.
 *
 * It must ASK (exactly one question) and it must name the word that accepts, because
 * the YES handler matches a bare affirmative and a parent who was never told the word
 * has no way in. Exported so the eval holds the same bar.
 */
export function offerViolations(sentence: string): string[] {
  const violations: string[] = [];
  const text = sentence.trim();

  if (text === '') return ['The offer was empty.'];
  if (text.length > MAX_OFFER_CHARS) {
    violations.push(
      `The offer is ${text.length} characters; it must be at most ${MAX_OFFER_CHARS} so the answer still fits.`,
    );
  }
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions !== 1) {
    violations.push(`The offer asks ${questions} questions; it must ask exactly one.`);
  }
  if (!/\byes\b/i.test(text)) {
    violations.push(
      'The offer never says YES. Name the word that accepts it, or the parent has no way to take it.',
    );
  }
  if (smsEncoding(text) !== 'gsm7') {
    violations.push('The offer contains a character that doubles the cost to send. Use plain ASCII.');
  }
  if (smsSegments(text) > 1) {
    violations.push('The offer is longer than one SMS segment. Shorten it.');
  }
  return violations;
}

/**
 * `offer_full_plan` — register the offer, so a YES has something to resolve against.
 *
 * The tool deliberately returns almost nothing. It does not compose the offer
 * sentence, because the skill owns Hale's voice and a tool that handed back finished
 * copy would put two authors on one message; it does not send anything, because
 * nothing about this turn has been sent yet.
 */
export function offerFullPlanTool(onOffer: (offer: PlanOffer) => void): RegisteredTool {
  return defineTool({
    name: 'offer_full_plan',
    description:
      "Register that you are offering this parent the COMPLETE plan for a raising-kids topic — the sequenced, night-by-night or day-by-day version of the answer you just gave, built on a named method. `offer` is the sentence that MAKES the offer, in your voice: one question, at most 160 plain-ASCII characters, and it must say YES, because that is the word the parent replies with. It is appended to your message for you, so do not write it again yourself. Nothing is sent by this tool. Pass `childId` only when the question was about one particular child and you have their id.",
    inputSchema: z.object({
      topic: z.enum(PLAN_TOPICS as [PlanTopic, ...PlanTopic[]]),
      childId: z.string().min(1).optional(),
      offer: z.string().min(1),
    }),
    // Invented placeholder id: examples ride the cached tool-definition grammar,
    // outside message protections (rule #1; see EXAMPLE_CHILD_ID).
    inputExamples: [
      { topic: 'sleep', offer: "Want the full plan? Reply YES and I'll send it." },
      {
        topic: 'solids',
        childId: EXAMPLE_CHILD_ID,
        offer: 'Want the whole first-foods plan? Say YES and it is yours.',
      },
    ],
    monetary: false,
    // `{offered:true}` and the topic back — nothing the answer waits on, so the loop
    // ends on the turn that calls this and the short advice beside it survives
    // (tool.ts registersOnly). A refused offer still costs a turn, which is right:
    // the model has a sentence to fix.
    registersOnly: true,
    // A child-scoped offer names a child, so the guarded invoker's teen check runs
    // BEFORE this handler — the same refusal propose_calendar_add gets. A 13+ child's
    // routine is not a thing Hale writes a parent a plan about (rule #1/#5).
    touchesChildContent: true,
    handler: async (input) => {
      // The gate, and the recompose loop in one: a refusal is thrown as a sentence the
      // model reads mid-turn and answers by calling again with a better offer. Nothing
      // is registered until one passes, so the runtime can only ever append an offer
      // that cleared every check.
      const violations = offerViolations(input.offer);
      if (violations.length > 0) {
        throw new Error(
          `That offer cannot be sent. ${violations.join(' ')} Call offer_full_plan again with a fixed one.`,
        );
      }
      const offer: PlanOffer = {
        topic: input.topic,
        childId: input.childId ?? null,
        sentence: input.offer.trim(),
      };
      onOffer(offer);
      return { offered: true as const, topic: input.topic };
    },
  });
}

/** What became of an offer's ledger write. Named rather than void because the offer is
 * the ONLY thing that makes a later YES mean anything: an offer sentence that reached a
 * parent with no row behind it is a question Hale cannot answer (rule #11). */
export type PlanOfferRecordOutcome =
  | { status: 'recorded'; commitmentId: string }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'write_failed' | 'already_open' };

export interface PlanOfferPorts {
  cancelCommitment: typeof cancelCommitment;
  recordCommitment: typeof recordCommitment;
}

/**
 * Write the offer down, against the message that carried it.
 *
 * SUPERSEDE FIRST, and it is not a nicety. The partial unique index permits one open
 * plan offer per family, so without this an insert for a family who ignored an earlier
 * offer conflicts and returns `already_open` — and that family could never be offered
 * a plan again, silently, forever. Cancelling is also the honest reading: Hale is
 * offering a plan RIGHT NOW, so a bare YES belongs to this offer and the old one is no
 * longer answerable.
 */
export async function recordPlanOffer(
  database: Database,
  input: {
    familyId: string;
    offer: PlanOffer;
    /** The outbound row that carried the offer sentence. Null means it never reached a
     * transport, and an unsent offer is not an offer. */
    channelMessageId: string | null;
    now: Date;
  },
  ports: PlanOfferPorts,
): Promise<PlanOfferRecordOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId, topic: input.offer.topic },
      'plan offer: no ledger row for the message that carried it - not recorded, a later YES will find nothing',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }

  await ports.cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'plan_offer',
    reason: 'plan_offer_superseded',
    now: input.now,
  });

  const outcome = await ports.recordCommitment(database, {
    familyId: input.familyId,
    kind: 'plan_offer',
    summary: planOfferSummary(input.offer.topic),
    topic: input.offer.topic,
    subjectChildId: input.offer.childId,
    dueAt: new Date(input.now.getTime() + PLAN_OFFER_TTL_HOURS * 3_600_000),
    channelMessageId: input.channelMessageId,
  });
  if (outcome.status === 'recorded') {
    return { status: 'recorded', commitmentId: outcome.commitmentId };
  }
  // `already_open` after a successful supersede means the cancel did not match — a lost
  // write, not a duplicate tick. Named as a failure here rather than folded in with the
  // ledger's benign reading of it, because at THIS call site it means the parent was
  // just offered a plan the YES handler will resolve to the WRONG topic.
  console.error(
    { familyId: input.familyId, topic: input.offer.topic, reason: outcome.status },
    'plan offer: the offer was sent but not recorded - a YES will not resolve to it',
  );
  return {
    status: 'not_recorded',
    reason: outcome.status === 'already_open' ? 'already_open' : outcome.reason,
  };
}

export function defaultPlanOfferPorts(): PlanOfferPorts {
  return { cancelCommitment, recordCommitment };
}
