import { twilioInboundDeps } from '~/lib/channel/twilio/deps';
import { handleTwilioInboundRequest } from '~/lib/channel/twilio/inbound';

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
  return handleTwilioInboundRequest(req, twilioInboundDeps());
}
