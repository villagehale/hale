import { after } from 'next/server';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { handlePreviewReminderTrigger } from '~/lib/channel/preview-reminder-trigger';
import { drainOrigin, kickDrain } from '~/lib/cron/kick-drain';
import { db } from '~/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/channels/preview/reminders — VIL-466. Fire the reminder cron for one fake
 * family on a Preview deploy, then kick the channel.send drain so its sends land in
 * preview_captured_sends now. Empty 404 everywhere else; the gates live in
 * lib/channel/preview-reminder-trigger.ts so vitest covers them.
 */
export async function POST(req: Request): Promise<Response> {
  const origin = drainOrigin(req);
  return handlePreviewReminderTrigger(req, {
    database: db(),
    afterRun: () => after(() => kickDrain(origin, [CHANNEL_SEND_QUEUE])),
    // Preview capture on: send in-process through the drain's own dispatch + capture
    // transport, no pg-boss and no drain kick (VIL-474).
    dispatchInProcess: async (job) => {
      const { channelSendJobPayloadSchema } = await import('@hale/tools-contracts');
      const { dispatchLoopMessage } = await import('~/lib/channel/dispatch');
      const { buildDispatchPorts } = await import('~/lib/channel/wiring');
      const { loopTemplateRenderer } = await import('~/lib/loop/templates/registry');
      const { productionChannels } = await import('~/lib/channel/adapters/production');
      const message = channelSendJobPayloadSchema.parse(job);
      await dispatchLoopMessage(
        message,
        buildDispatchPorts(db(), {
          channels: productionChannels(db()),
          renderer: loopTemplateRenderer,
        }),
      );
    },
  });
}
