import { after } from 'next/server';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { linqInboundDeps } from '~/lib/channel/linq/deps';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { withWebhookFailureAlert } from '~/lib/channel/twilio/alert';
import { kickDrain } from '~/lib/cron/kick-drain';

// Node runtime: signature verification is node:crypto HMAC, and the handler
// reaches pg-boss. Neither runs on the edge runtime.
export const runtime = 'nodejs';

/**
 * POST /api/channels/linq/inbound — an iMessage a parent sends Hale (VIL-335).
 *
 * A shell on purpose, matching the Twilio door: the gates live in lib/channel/linq
 * so vitest covers them, and the only thing that can differ on the deployed path
 * is which dependencies are injected. The whole body, dependency construction
 * included, sits inside the failure boundary (VIL-331).
 *
 * Subscribe this URL with `?version=2026-02-03` (see the module comment on
 * signature.ts). Linq retries 5xx; a healthy door answers 200 and the reply
 * leaves later, through the partner API, from the conversation router.
 */
export async function POST(req: Request): Promise<Response> {
  return withWebhookFailureAlert('linq_inbound', async () => {
    const deps = linqInboundDeps();
    const origin = process.env.APP_URL ?? new URL(req.url).origin;
    return handleLinqInboundRequest(req, {
      ...deps,
      enqueue: async (job) => {
        await deps.enqueue(job);
        after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
      },
    });
  });
}
