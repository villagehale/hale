import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { createExpoPushChannel } from '~/lib/push/channel';
import { createExpoPushClient } from '~/lib/push/expo-client';
import type { Channel, ChannelKind } from '../types';
import { createExpoPushChannelAdapter } from './expo-push';
import { createResendEmailChannel } from './resend-email';
import { createTwilioSmsChannel } from './twilio-sms';

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
    email: createResendEmailChannel({
      resolveEmail: async (userId: string) => {
        const rows = await database
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        return rows[0]?.email ?? null;
      },
    }),
    push: createExpoPushChannelAdapter({
      push: createExpoPushChannel({ database, client: createExpoPushClient() }),
    }),
    // The ONE send-side reader (VIL-262): it carries the verified + non-revoked
    // predicate itself, so the SMS leg fails closed on its own rather than on the
    // dispatch having run the consent check first.
    sms: createTwilioSmsChannel({
      resolveTarget: (userId: string) => resolveSendablePhone(database, userId),
    }),
  };
}
