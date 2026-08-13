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
}

/**
 * What one turn produced: the reply, and — when the coach offered a full coaching plan
 * — the offer the router must write down once the reply has actually been sent.
 *
 * The offer rides OUT rather than being written by the tool because the ledger row is
 * minted against the outbound message that carried it, and that message does not exist
 * until the router sends it. Null is the ordinary case and means exactly one thing:
 * this turn promised nothing.
 */
export interface ChannelTurnResult {
  reply: string;
  planOffer: PlanOffer | null;
}

export interface ChannelCoachRuntime {
  respond(turn: ChannelTurn): Promise<ChannelTurnResult>;
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
      return { reply: capabilityReply(), planOffer: null };
    },
  };
}
