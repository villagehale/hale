import { after } from 'next/server';
import { twilioInboundDeps } from '~/lib/channel/twilio/deps';
import { handleTwilioInboundRequest } from '~/lib/channel/twilio/inbound';
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
    enqueue: async (job) => {
      await deps.enqueue(job);
      after(() => kickDrain(origin));
    },
  });
}
