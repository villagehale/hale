import type { AckEtaRouterPorts } from '~/lib/channel/ack-eta/arm';

/**
 * VIL-717 · the ack ports for a router test that is NOT about the ack.
 *
 * Request mechanics only, no model judgement under test: the reader reports that the text
 * asks for no slow job, so a slow turn falls through to exactly what it does with the ack
 * lane quiet (the holding tapback where one is lit, nothing on SMS). Nothing is written and
 * nothing pages. While ACK_ETA_ENABLED is off (every ordinary run) none of this is called;
 * the all-flags-on CI job is the run that reaches it.
 *
 * The ack's own behaviour is driven in channel/ack-eta/*.test.ts and in route.test.ts's
 * ACK_ETA_ENABLED block; what the model reads and writes is the cached eval's job (rule #8).
 */
export function quietAckEtaPorts(): AckEtaRouterPorts & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async read(parentText) {
        reads.push(parentText);
        return { status: 'read', task: 'none' };
      },
    },
    writer: {
      ack: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
      lateNote: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
    },
    record: async () => ({ status: 'not_recorded', reason: 'write_failed' }),
    page: async () => 'page_not_configured',
  };
}
