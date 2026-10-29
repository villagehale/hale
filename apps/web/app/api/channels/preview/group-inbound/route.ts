import { after } from 'next/server';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { linqInboundDeps } from '~/lib/channel/linq/deps';
import { handlePreviewFakeGroupInbound } from '~/lib/channel/preview-fake-group-inbound';
import { kickDrain } from '~/lib/cron/kick-drain';

export const runtime = 'nodejs';

/**
 * POST /api/channels/preview/group-inbound — VIL-466 groups. One fake parent's
 * message in a fake household group, run through the Linq door's group handler.
 * 404 everywhere else; gates live in lib/channel/preview-fake-group-inbound.ts.
 */
export async function POST(req: Request): Promise<Response> {
  const deps = linqInboundDeps();
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  return handlePreviewFakeGroupInbound(req, {
    ...deps,
    countOutcome: async () => {},
    enqueue: async (job) => {
      await deps.enqueue(job);
      after(() => kickDrain(origin, INBOUND_TURN_QUEUES));
    },
  });
}
