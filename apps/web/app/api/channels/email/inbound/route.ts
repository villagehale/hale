import { emailInboundDeps } from '~/lib/channel/email/deps';
import { handleEmailInboundRequest } from '~/lib/channel/email/inbound';

// Node runtime: the handler reaches node:crypto HMAC, the Resend SDK, and Postgres
// (raw pg + prepared statements) — none of which run on the edge runtime.
export const runtime = 'nodejs';

/**
 * POST /api/channels/email/inbound — every email a parent sends Hale.
 *
 * A shell on purpose, exactly like the Twilio one: the gates, the routing and the
 * ledger writes all live in lib/channel/email so they are unit-testable (vitest covers
 * lib/**, not app/**), and so the only thing that can differ between the tested path and
 * the deployed one is which dependencies are injected.
 *
 * No drain kick, unlike the SMS twin: this phase enqueues nothing. The inbound router
 * C1 owns can only reply by SMS today, so an email is recorded and named rather than
 * handed to it (see the module note in inbound.ts). When the router learns to answer on
 * the channel a message arrived on, the kick belongs here alongside the enqueue.
 */
export async function POST(req: Request): Promise<Response> {
  return handleEmailInboundRequest(req, emailInboundDeps());
}
