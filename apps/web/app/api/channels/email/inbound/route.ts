import { after } from 'next/server';
import { emailInboundDeps } from '~/lib/channel/email/deps';
import { handleEmailInboundRequest } from '~/lib/channel/email/inbound';
import { withWebhookFailureAlert } from '~/lib/channel/twilio/alert';
import { INBOUND_TURN_QUEUES } from '~/lib/cron/drain';
import { kickDrain } from '~/lib/cron/kick-drain';

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
 * The drain kick is composed around `enqueue`, exactly as the SMS twin composes it:
 * every outcome that queues nothing — a forged request, an unsubscribe, an auto-reply,
 * a stranger — therefore cannot provoke a drain, because the kick is reachable only
 * through the one call that put a job on the queue.
 */
export async function POST(req: Request): Promise<Response> {
  // The whole body — dependency construction included — is inside the failure boundary
  // (VIL-331), exactly like the Twilio doors: the 2026-08-28 incident threw from the
  // first DB touch, before any handler logic ran. A svix retry on the 500 is welcome —
  // it redelivers a message we never recorded.
  return withWebhookFailureAlert('email_inbound', async () => {
    const deps = emailInboundDeps();
    const origin = process.env.APP_URL ?? new URL(req.url).origin;
    return handleEmailInboundRequest(req, {
      ...deps,
      // RETURNED, not fired: after() keeps this instance alive only while the callback is
      // pending, and a callback that returns nothing can be frozen with the kick's request
      // still unsent (kick-drain.ts).
      enqueue: async (job) => {
        await deps.enqueue(job);
        after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
      },
    });
  });
}
