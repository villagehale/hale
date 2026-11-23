import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import {
  offerConnectorLink,
  offerConnectorLinks,
  offerGoogleBundleLink,
} from '~/lib/channel/connect/offer';
import type { GoogleBundleLink, TextConnectProvider } from '~/lib/channel/connect/text-connect';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import {
  createOutboundTransport,
  failedSendPatch,
  plainTextWithoutLinks,
  readSendRefusal,
  sendLinqChatMessage,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { threadProactiveMessage } from '~/lib/channel/thread';
import {
  type SaidLineWriter,
  createSaidLineWriter,
  writeConnectorLink,
  writeConnectorLinks,
  writeGoogleBundleLink,
} from '~/lib/channel/voice/said-line';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { pageOps } from '~/lib/monitoring/failure-page';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';

/**
 * A connect that expired, was denied, or failed. Hale mints a new one-tap link
 * for the provider the parent was already trying, and texts it. The page does
 * not tell them a phrase to type.
 *
 * Rule #11: every way this ends is named. A missing number is `no_send_target`,
 * never a sentence that claims a text left.
 */

export const FRESH_CONNECTOR_LINK_TEMPLATE_KEY = 'connector:fresh_link';

export interface FreshLinkPorts {
  transport: ChannelTransport;
  imessage?: (input: { chatId: string; body: string }) => Promise<{ providerMessageId: string }>;
  threadMessage: typeof threadProactiveMessage;
  /** #868: writes the both-links text. Absent → that text is not sent. */
  saidLine?: SaidLineWriter;
}

export type FreshLinkOutcome =
  | 'sent'
  /** A new Linq chat took only the words: the parent has a text that names a link and
   * carries none. */
  | 'link_omitted'
  | 'not_enrolled'
  | 'mint_failed'
  | 'no_send_target'
  | 'no_chat'
  | 'send_failed'
  | 'errored';

export function defaultFreshLinkPorts(): FreshLinkPorts {
  return {
    transport: createOutboundTransport(),
    imessage: (input) => sendLinqChatMessage({ chatId: input.chatId, text: input.body }),
    threadMessage: threadProactiveMessage,
    saidLine: createSaidLineWriter(() =>
      budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'spoken_line' }),
    ),
  };
}

export async function textFreshConnectorLink(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    /**
     * `both` is one text carrying both links, minted together so neither spends the other.
     * `google` is VIL-721's one link that connects both in one consent.
     */
    provider: TextConnectProvider | 'both' | GoogleBundleLink;
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
    provider: TextConnectProvider | 'both' | GoogleBundleLink;
    now: Date;
  },
  ports: FreshLinkPorts,
): Promise<FreshLinkOutcome> {
  const language = await parentLinkLanguage(database, args.familyId, args.parentUserId);
  const minted = await mintBody(database, args, language, ports.saidLine);
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

  const door = await resolveMessagingDoor(database, args.parentUserId, {
    excludeChatId: await familyGroupChatId(database, args.familyId),
  });
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

  const body = minted.body;
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
  let linkOmitted = false;
  try {
    if (door.channel === 'imessage') {
      const send = ports.imessage;
      if (!send || !chatId) throw new LinqSendError('imessage_not_configured', 0, true);
      ({ providerMessageId } = await send({ chatId, body }));
    } else {
      const sent = await sendResolvingNewChat(ports.transport, { to: phone, body });
      providerMessageId = sent.providerMessageId;
      linkOmitted = sent.linkOmitted !== undefined;
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
    body: linkOmitted ? plainTextWithoutLinks(body) : body,
  });
  if (linkOmitted) {
    console.warn(
      { familyId: args.familyId, provider: args.provider },
      'connector link: fresh link text sent without its link',
    );
    return 'link_omitted';
  }
  console.info(
    { familyId: args.familyId, provider: args.provider },
    'connector link: fresh link sent',
  );
  return 'sent';
}

/**
 * VIL-721. The one link's text in the model's words, or nothing and a page to #ops:
 * no onboarding text has a fixed line to fall back on, and a log line pages nobody.
 */
export async function writeGoogleLinkOrPage(
  database: Database,
  saidLine: SaidLineWriter | undefined,
  input: { language: ReplyLanguage | null; url: string },
): Promise<string | null> {
  const body = await writeGoogleBundleLink(saidLine, input);
  if (body) return body;
  await pageOps(database, {
    site: 'connector_link_unwritten',
    facts: { reason: saidLine ? 'write_failed' : 'writer_absent' },
  });
  return null;
}

async function mintBody(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    provider: TextConnectProvider | 'both' | GoogleBundleLink;
    now: Date;
  },
  language: ReplyLanguage,
  saidLine: SaidLineWriter | undefined,
): Promise<{ status: 'minted'; body: string } | { status: 'not_enrolled' | 'mint_failed' }> {
  const owner = { familyId: args.familyId, parentUserId: args.parentUserId, now: args.now };
  if (args.provider === 'google') {
    // VIL-721. A failed one-link connect gets a fresh ONE link, never the two.
    const minted = await offerGoogleBundleLink(database, owner);
    if (minted.status !== 'minted') return minted;
    const body = await writeGoogleLinkOrPage(database, saidLine, { language, url: minted.url });
    // A failed write sends nothing; the minted link simply expires unused.
    return body ? { status: 'minted', body } : { status: 'mint_failed' };
  }
  if (args.provider === 'both') {
    const minted = await offerConnectorLinks(database, { ...owner, providers: ['gcal', 'gmail'] });
    if (minted.status !== 'minted') return minted;
    const body = await writeConnectorLinks(saidLine, {
      language,
      calendarUrl: minted.urls[0],
      gmailUrl: minted.urls[1],
    });
    // A failed write sends nothing; the minted links simply expire unused.
    return body ? { status: 'minted', body } : { status: 'mint_failed' };
  }
  const minted = await offerConnectorLink(database, { ...owner, provider: args.provider });
  if (minted.status !== 'minted') return minted;
  const body = await writeConnectorLink(saidLine, {
    language,
    provider: args.provider,
    url: minted.url,
  });
  // A failed write sends nothing; the minted link simply expires unused.
  return body ? { status: 'minted', body } : { status: 'mint_failed' };
}

/** A link is one person's: the family group is never its door. */
async function familyGroupChatId(database: Database, familyId: string): Promise<string | null> {
  const [row] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.linqGroupChatId ?? null;
}

/** The parent's stored language, as English or French. A null store falls back to the
 * family language. Only an exact `fr` is French, as before. */
async function parentLinkLanguage(
  database: Database,
  familyId: string,
  parentUserId: string,
): Promise<ReplyLanguage> {
  const stored = await readParentLanguage(database, { familyId, parentUserId });
  return stored === 'fr' ? 'fr' : 'en';
}
