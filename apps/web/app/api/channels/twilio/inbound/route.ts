import { after } from 'next/server';
import { twilioInboundDeps } from '~/lib/channel/twilio/deps';
import { handleTwilioInboundRequest } from '~/lib/channel/twilio/inbound';
import { INBOUND_TURN_QUEUES } from '~/lib/cron/drain';
import { kickDrain } from '~/lib/cron/kick-drain';

// Node runtime: the handler reaches pg-boss (raw pg + prepared statements), node:crypto
// HMAC, and the Anthropic SDK — none of which run on the edge runtime.
export const runtime = 'nodejs';

/**
 * POST /api/channels/twilio/inbound — every text a parent sends Hale (VIL-214 · A3).
 *
 * A shell on purpose: the gates, the routing, and the handoff all live in
 * lib/channel/twilio so they are unit-testable (vitest covers lib/**, not app/**), and
 * so the only thing that can differ between the tested path and the deployed one is
 * which dependencies are injected.
 */
export async function POST(req: Request): Promise<Response> {
  const deps = twilioInboundDeps();
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  return handleTwilioInboundRequest(req, {
    ...deps,
    // The drain kick every other hot-queue producer already does, so a parent's text
    // starts its turn now instead of waiting up to 60s for the cron tick. Composed
    // around `enqueue` rather than dropped after the response on purpose: a forged
    // request, a STOP, and an intake turn all queue nothing, so none of them can
    // provoke a drain.
    //
    // RETURNED, not fired: after() keeps this instance alive only while the callback is
    // pending, and a callback that returns nothing can be frozen with the kick's request
    // still unsent (kick-drain.ts). The slice is the inbound queue alone, so what we wait
    // on is this parent's turn and nothing else's backlog.
    enqueue: async (job) => {
      await deps.enqueue(job);
      after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
    },
  });
}
