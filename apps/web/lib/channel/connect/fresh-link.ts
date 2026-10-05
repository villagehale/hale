import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { offerConnectorLink } from '~/lib/channel/connect/offer';
import type { TextConnectProvider } from '~/lib/channel/connect/text-connect';
import {
  type ConnectVoice,
  defaultConnectVoice,
  speakConnectLine,
} from '~/lib/channel/connect/voice';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import {
  createOutboundTransport,
  failedSendPatch,
  readSendRefusal,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';

/**
 * A connect that expired, was denied, or failed. Hale mints a new one-tap link
 * for the provider the parent was already trying, and texts it. The page does
 * not tell them a phrase to type.
 *
 * Rule #11: every way this ends is named. A missing number is `no_send_target`,
 * never a sentence that claims a text left. The line over the link is the model's
 * (connect/voice.ts); when it could not write one, `voice_unsent` — nothing is texted,
 * #ops is paged, the minted token expires unused.
 */

export const FRESH_CONNECTOR_LINK_TEMPLATE_KEY = 'connector:fresh_link';

export interface FreshLinkPorts {
  transport: ChannelTransport;
  imessage?: (input: { chatId: string; body: string }) => Promise<{ providerMessageId: string }>;
  threadMessage: typeof threadProactiveMessage;
  /** `undefined` is the named no-key state: nothing is sent and #ops is paged. */
  voice: ConnectVoice | undefined;
}

export type FreshLinkOutcome =
  | 'sent'
  | 'not_enrolled'
  | 'mint_failed'
  | 'no_send_target'
  | 'no_chat'
  | 'voice_unsent'
  | 'send_failed'
  | 'errored';

export function defaultFreshLinkPorts(): FreshLinkPorts {
  return {
    transport: createOutboundTransport(),
    imessage: (input) => sendLinqChatMessage({ chatId: input.chatId, text: input.body }),
    threadMessage: threadProactiveMessage,
    voice: defaultConnectVoice(),
  };
}

export async function textFreshConnectorLink(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    provider: TextConnectProvider;
    now: Date;
  },
  ports: FreshLinkPorts = defaultFreshLinkPorts(),
): Promise<FreshLinkOutcome> {
  try {
    return await sendFresh(database, args, ports);
  } catch (err) {
    console.error(
      {
        familyId: args.familyId,
        provider: args.provider,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'connector link: fresh link threw',
    );
    return 'errored';
  }
}

async function sendFresh(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    provider: TextConnectProvider;
    now: Date;
  },
  ports: FreshLinkPorts,
): Promise<FreshLinkOutcome> {
  const minted = await offerConnectorLink(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    provider: args.provider,
    now: args.now,
  });
  if (minted.status !== 'minted') {
    console.info(
      { familyId: args.familyId, provider: args.provider, outcome: minted.status },
      'connector link: fresh link not minted',
    );
    return minted.status;
  }

  const phone = await resolveSendablePhone(database, args.parentUserId);
  if (!phone) {
    console.info(
      { familyId: args.familyId, provider: args.provider },
      'connector link: fresh link not sent - no sendable number',
    );
    return 'no_send_target';
  }

  const door = await resolveMessagingDoor(database, args.parentUserId);
  const chatId = door.channel === 'imessage' ? door.chatId : null;
  if (door.channel === 'imessage' && !chatId) {
    console.info(
      { familyId: args.familyId, provider: args.provider },
      'connector link: fresh link not sent - iMessage has no chat',
    );
    return 'no_chat';
  }
  if (door.channel === 'imessage' && !ports.imessage) {
    console.info(
      { familyId: args.familyId, provider: args.provider },
      'connector link: fresh link not sent - iMessage sender absent',
    );
    return 'send_failed';
  }

  const language = await familyLanguage(database, args.familyId);
  const line = await speakConnectLine(
    ports.voice,
    { kind: 'offer', account: args.provider },
    language,
    { urls: [minted.url], scope: { familyId: args.familyId, database } },
  );
  if (line.body === null) {
    console.info(
      { familyId: args.familyId, provider: args.provider },
      'connector link: fresh link not sent - no line could be written',
    );
    return 'voice_unsent';
  }
  const body = line.body;
  const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel,
      direction: 'out',
      category: 'reply',
      templateKey: FRESH_CONNECTOR_LINK_TEMPLATE_KEY,
      providerChatId: chatId,
      status: acceptedStatus(channel),
      sentAt: args.now,
    })
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'errored';

  let providerMessageId: string;
  try {
    if (door.channel === 'imessage') {
      const send = ports.imessage;
      if (!send || !chatId) throw new LinqSendError('imessage_not_configured', 0, true);
      ({ providerMessageId } = await send({ chatId, body }));
    } else {
      ({ providerMessageId } = await sendResolvingNewChat(ports.transport, { to: phone, body }));
    }
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await database
      .update(schema.channelMessages)
      .set(failedSendPatch(code))
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId: args.familyId, provider: args.provider, code },
      'connector link: fresh link refused',
    );
    return 'send_failed';
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));
  await ports.threadMessage(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    body,
  });
  console.info(
    { familyId: args.familyId, provider: args.provider },
    'connector link: fresh link sent',
  );
  return 'sent';
}

async function familyLanguage(database: Database, familyId: string): Promise<ReplyLanguage> {
  const rows = await database
    .select({ id: schema.families.id, primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  const row = rows.find((candidate) => candidate.id === familyId);
  return row?.primaryLanguage === 'fr' ? 'fr' : 'en';
}
