import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';

/**
 * The gate, reading each asker's quiet floor on the check-back's clock (the asker's own
 * zone, else the household's: `knownParentTimezone`). The gate's own port reads the
 * stored `users.timezone` as is, where the UTC default means "never set". Every other
 * parent reads as the gate reads them.
 */
export function onCheckbackClock(
  ports: OutboundGatePorts,
  clocks: ReadonlyMap<string, string>,
): OutboundGatePorts {
  return {
    ...ports,
    parentTimeZone: async (parentUserId) =>
      clocks.get(parentUserId) ?? ports.parentTimeZone(parentUserId),
  };
}
