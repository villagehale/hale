import { captureInboundRouted } from '~/lib/analytics/server-capture';
import { buildIntakeDeps, enqueueChannelMessageReceived } from '~/lib/channel/inbound-deps';
import type { InboundRouteDeps } from '~/lib/channel/inbound-route';
import { db } from '~/lib/db';

/**
 * Production wiring for the Linq inbound door. The queue, the intake machine,
 * and the conversation router are the SMS door's — an iMessage is a text from
 * the same parent, on a different pipe.
 */
export function linqInboundDeps(): InboundRouteDeps {
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
