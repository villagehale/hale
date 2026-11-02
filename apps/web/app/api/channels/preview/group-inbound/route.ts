import { after } from 'next/server';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { linqInboundDeps } from '~/lib/channel/linq/deps';
import { handlePreviewFakeGroupInbound } from '~/lib/channel/preview-fake-group-inbound';
import { drainOrigin, kickDrain } from '~/lib/cron/kick-drain';

export const runtime = 'nodejs';

/**
 * POST /api/channels/preview/group-inbound — VIL-466 groups. One fake parent's
 * message in a fake household group, run through the Linq door's group handler.
 * Optional `media` (an https url, or Linq's media_url / mime_type / filename) is
 * delivered as the same media parts the signed group webhook parses.
 * 404 everywhere else; gates live in lib/channel/preview-fake-group-inbound.ts.
 */
export async function POST(req: Request): Promise<Response> {
  const deps = linqInboundDeps();
  const origin = drainOrigin(req);
  return handlePreviewFakeGroupInbound(req, {
    ...deps,
    countOutcome: async () => {},
    enqueue: async (job) => {
      await deps.enqueue(job);
      after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
    },
  });
}
