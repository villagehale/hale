import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import type { PlanOffer } from '~/lib/channel/plan/offer';
import { capabilityReply } from './copy';

/**
 * VIL-220 · C1 → VIL-221 · C2 — the seam between the router and the agent.
 *
 * C1 owns everything up to the model and everything after it: threading, ordering, the
 * deterministic answers, flood control, the ledger, the audit row, and the reply. What
 * it does NOT own is the reasoning, so the reasoning lives behind this one method.
 *
 * The interface is deliberately narrow. It takes an already-THREADED turn — the
 * conversation exists and the parent's message is already the last row in it — so C2's
 * job is to read that thread and answer, not to re-resolve who is talking. That is what
 * makes the two tickets separable: C2 can grow tools, streaming, and a terser voice
 * without touching a line of routing, and C1's ordering guarantees hold whatever C2
 * does, because C2 is only ever reached once they have all passed.
 *
 * A throw is a FAILED TURN, not a silent one: the router answers it with the honesty
 * template. So C2 should throw rather than return an apologetic string — an error the
 * router can see is better than one it cannot.
 *
 * WHAT A FAILED TURN OWES THE ROUTER (VIL-260). "Nothing was changed" was the template
 * for every failure, and it was false whenever the turn had already drafted: the
 * propose_* tools commit rows the moment they are called, so a turn that drafts two
 * changes and THEN runs out of steps leaves two real actions in the approvals queue.
 * Telling the parent nothing happened orphans them — they never learn the drafts exist,
 * so the next unrelated "yes" is what finds them. A failure therefore carries what it
 * already did, in {@link ChannelTurnFailed}.
 */

export interface ChannelTurn {
  familyId: string;
  parentUserId: string;
  /** The thread this turn belongs to; the parent's message is already appended. */
  conversationId: string;
  body: string;
  now: Date;
  /**
   * What Hale is still waiting to hear back about, as the short noun phrases HALE ITSELF
   * would say them in ("booking that visit", "meeting the family nearby") — never a
   * payload, never another household, never an internal label a parent has not seen.
   *
   * IT IS CONTEXT, NOT INSTRUCTION, and that is why it is here rather than in the skill.
   * The coach is reached on two turns that need it and used to be blind on both:
   *
   *   · a parent plainly ANSWERED something and the resolver could not place which
   *     (2026-08-20). Hale used to reply with a machine-built multiple choice; the coach
   *     can ask the same question as a person, and can only do that if it knows what the
   *     candidates were.
   *   · a parent said something ordinary while a question was pending, and the coach,
   *     knowing nothing about it, said "I don't have a draft waiting for your YES right
   *     now" while one was (the prod failure the resolver eval's first fixture records).
   *
   * Empty is the ordinary case and means exactly what it says: Hale is waiting on nothing.
   */
  standingQuestions: readonly string[];
}

/**
 * What one turn produced: the reply, plus anything the turn PROMISED that the router
 * must write down once the reply has actually been sent.
 *
 * Both promises ride OUT rather than being written by their tools because a ledger row is
 * minted against the outbound message that carried it, and that message does not exist
 * until the router sends it. Null is the ordinary case for each and means exactly one
 * thing: this turn promised that.
 */
export interface ChannelTurnResult {
  reply: string;
  planOffer: PlanOffer | null;
  /**
   * The "I'll come back to you" this turn said out loud, if it said one. The sweep owes
   * this family an answer within the day — see channel/activity/commitment.ts for what a
   * promise with no row behind it cost on 2026-08-20.
   */
  activityPromise: ActivityPromise | null;
}

export interface ChannelCoachRuntime {
  /**
   * `rejectedLastAttempt` is WHY THE LAST ATTEMPT WAS NOT SENDABLE — the reconciliation
   * primitive's violations (VIL-293), in the second person the model will act on.
   *
   * Empty on every first attempt, which is nearly every turn. Non-empty means this turn
   * has already run once and wrote a sentence claiming a row that does not exist: a
   * watch nothing is watching, a follow-up nothing registered, a booking nothing holds.
   * The reply was NOT sent, so it is a rewrite rather than a correction — the parent has
   * heard nothing yet.
   *
   * A PARAMETER RATHER THAN A FIELD ON {@link ChannelTurn}, because a turn is what a
   * parent said and this is what Hale got wrong about it. `HandlerContext` widens
   * `ChannelTurn`, and every deterministic handler in the chain would otherwise carry a
   * field about a model retry none of them can have.
   *
   * REQUIRED, not optional (rule #11): a caller that forgot it would silently get the
   * first-attempt prompt on a retry, and the turn would compose the same false sentence
   * forever with nothing saying why.
   */
  respond(turn: ChannelTurn, rejectedLastAttempt: readonly string[]): Promise<ChannelTurnResult>;
}

/**
 * A turn that broke, carrying the actions it had already drafted before it did.
 *
 * The ids are the turn's own — minted by the propose_* tools during THIS text, never a
 * query of what happens to be pending — so the count in the reply cannot include a draft
 * the parent has already been told about.
 */
export class ChannelTurnFailed extends Error {
  readonly draftedActionIds: readonly string[];

  constructor(
    message: string,
    options: { cause?: unknown; draftedActionIds: readonly string[] },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ChannelTurnFailed';
    this.draftedActionIds = options.draftedActionIds;
  }
}

/** What a failed turn committed, or nothing at all — the ordinary case, and the one
 * where "nothing was changed" is the true sentence. */
export function draftsFromFailure(err: unknown): readonly string[] {
  return err instanceof ChannelTurnFailed ? err.draftedActionIds : [];
}

/**
 * The stub C1 shipped with, and the reason the inbound leg went live before C2 did.
 *
 * Production now wires the real runtime (`~/lib/channel/coach/runtime`, VIL-221), but
 * this stays: it is the degraded implementation, answering every message with the
 * Conversation Design's out-of-scope line (§3) — an honest statement of what Hale does
 * plus where the rest lives. C2 keeps that same line for genuinely out-of-scope asks,
 * so the stub is the narrow case of the real thing rather than a dead alternative.
 */
export function capabilityStubRuntime(): ChannelCoachRuntime {
  return {
    async respond() {
      return { reply: capabilityReply(), planOffer: null, activityPromise: null };
    },
  };
}
