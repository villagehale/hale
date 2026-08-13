import { type RegisteredTool, defineTool } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { cancelCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { EXAMPLE_CHILD_ID } from '~/lib/coach/tools';
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
 * WHY THE TOPIC IS AN ENUM. It is persisted, and three days later it selects a
 * sentence Hale sends UNPROMPTED. See topics.ts — a model-authored topic would be
 * model-authored prose on a proactive template with nobody in the loop.
 */

/** What the coach registered this turn: which plan it offered, and about whom. */
export interface PlanOffer {
  topic: PlanTopic;
  /** The child the question was about, when the parent named one. Null for a
   * question about the household, or an only child the model did not bother to name. */
  childId: string | null;
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
      "Register that you are offering this parent the COMPLETE plan for a raising-kids topic — the sequenced, day-by-day version of the answer you just gave. Call it AFTER you have already answered their question, then close your message by offering the plan and asking for a YES. It sends nothing on its own. Pass `childId` only when the parent's question was about one particular child and you have their id.",
    inputSchema: z.object({
      topic: z.enum(PLAN_TOPICS as [PlanTopic, ...PlanTopic[]]),
      childId: z.string().min(1).optional(),
    }),
    // Invented placeholder id: examples ride the cached tool-definition grammar,
    // outside message protections (rule #1; see EXAMPLE_CHILD_ID).
    inputExamples: [{ topic: 'sleep' }, { topic: 'solids', childId: EXAMPLE_CHILD_ID }],
    monetary: false,
    // A child-scoped offer names a child, so the guarded invoker's teen check runs
    // BEFORE this handler — the same refusal propose_calendar_add gets. A 13+ child's
    // routine is not a thing Hale writes a parent a plan about (rule #1/#5).
    touchesChildContent: true,
    handler: async (input) => {
      const offer: PlanOffer = { topic: input.topic, childId: input.childId ?? null };
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
