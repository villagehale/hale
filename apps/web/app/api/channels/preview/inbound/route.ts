import { after } from 'next/server';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { linqInboundDeps } from '~/lib/channel/linq/deps';
import { handlePreviewFakeInbound } from '~/lib/channel/preview-fake-inbound';
import { drainOrigin, kickDrain } from '~/lib/cron/kick-drain';

export const runtime = 'nodejs';

/**
 * POST /api/channels/preview/inbound — VIL-466. A fake family's text on a Preview
 * deploy, run through the same router as the Linq door. 404 everywhere else; the
 * gates live in lib/channel/preview-fake-inbound.ts so vitest covers them.
 */
export async function POST(req: Request): Promise<Response> {
  const deps = linqInboundDeps();
  const origin = drainOrigin(req);
  return handlePreviewFakeInbound(req, {
    ...deps,
    countOutcome: async () => {},
    enqueue: async (job) => {
      await deps.enqueue(job);
      after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
    },
  });
}
