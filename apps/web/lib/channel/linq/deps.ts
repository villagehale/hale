import { captureInboundRouted } from '~/lib/analytics/server-capture';
import { buildIntakeDeps, enqueueChannelMessageReceived } from '~/lib/channel/twilio/deps';
import type { TwilioInboundDeps } from '~/lib/channel/twilio/inbound';
import { db } from '~/lib/db';

/**
 * Production wiring for the Linq inbound door. The queue, the intake machine,
 * and the conversation router are the SMS door's — an iMessage is a text from
 * the same parent, on a different pipe.
 */
export function linqInboundDeps(): TwilioInboundDeps {
  return {
    database: db(),
    intake: buildIntakeDeps,
    enqueue: enqueueChannelMessageReceived,
    log: console,
    countOutcome: async (outcome) => {
      await captureInboundRouted('imessage', outcome);
    },
  };
}
