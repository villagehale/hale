import type { Database } from '@hale/db';
import { familyOutboundTargetForUser } from '~/lib/channel/linq/family-outbound';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import type { Channel, ChannelKind } from '../types';
import { createSmsChannel } from './phone-sms';

/**
 * The seam's real adapters, in ONE construction.
 *
 * Two callers now send through the dispatch — the drain (every composed loop message)
 * and the calendar-invite fan-out (VIL-249) — and a second hand-rolled copy of this
 * object is how the two end up disagreeing about, say, which reader resolves a
 * sendable number. There is exactly one right answer per channel and it lives here.
 */
export function productionChannels(database: Database): Partial<Record<ChannelKind, Channel>> {
  return {
    // The ONE send-side reader (VIL-262): it carries the verified + non-revoked
    // predicate itself, so the SMS leg fails closed on its own rather than on the
    // dispatch having run the consent check first. The leg's default transport
    // is Linq; this construction does not pass a Twilio sender.
    sms: createSmsChannel({
      resolveTarget: (userId: string) => resolveSendablePhone(database, userId),
      familyTarget: (userId: string) => familyOutboundTargetForUser(database, userId),
      database,
    }),
  };
}
