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
 * template (nothing was changed + the app link). So C2 should throw rather than return
 * an apologetic string — an error the router can see is better than one it cannot.
 */

export interface ChannelTurn {
  familyId: string;
  parentUserId: string;
  /** The thread this turn belongs to; the parent's message is already appended. */
  conversationId: string;
  body: string;
  now: Date;
}

export interface ChannelCoachRuntime {
  respond(turn: ChannelTurn): Promise<{ reply: string }>;
}

/**
 * The stub C1 ships with, and the reason the inbound leg can go live before C2 does.
 *
 * It answers every non-deterministic message with the Conversation Design's
 * out-of-scope line (§3) — an honest statement of what Hale can do today plus where the
 * rest lives. That is a worse answer than C2 will give and a much better one than
 * silence, and it is the same reply C2 will keep for genuinely out-of-scope asks, so
 * swapping the implementation narrows the stub rather than replacing it.
 */
export function capabilityStubRuntime(): ChannelCoachRuntime {
  return {
    async respond() {
      return { reply: capabilityReply() };
    },
  };
}
