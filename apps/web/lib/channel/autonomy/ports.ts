import type { Database } from '@hale/db';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { composeAutonomyNotice } from './compose';
import { type AutonomyNoticePorts, autonomyNoticeReaders } from './notice';

/**
 * The ports the turn-on and on-its-own notices need. Built here so `notice.ts`
 * constructs no transport and stays off the outbound one-door allowlist.
 */
export function autonomyNoticePorts(database: Database): AutonomyNoticePorts {
  return {
    ...autonomyNoticeReaders(database),
    compose: (input) => composeAutonomyNotice(input),
    transport: createOutboundTransport(),
    threadMessage: threadProactiveMessage,
  };
}
