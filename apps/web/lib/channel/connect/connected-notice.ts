import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { parentNeedsName } from '~/lib/channel/identity/name-reply';
import { groupsFromFindBody } from '~/lib/channel/intake/activity-map';
import { sendYearConnectorCards } from '~/lib/channel/intake/connector-offer';
import { summarizeChildren } from '~/lib/channel/intake/derive';
import {
  type FriendVoiceComposer,
  createFriendVoiceComposer,
  pageOncePerDay,
  speakFriend,
} from '~/lib/channel/intake/friend-voice';
import { onboardingFriendVoiceEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  type OnboardingChecklist,
  agesAreComplete,
  kidsAreNamed,
} from '~/lib/channel/intake/onboarding-turn';
import {
  type IntakeSession,
  loadOpenSessionByFamily,
  saveSession,
} from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { familyOutboundTarget, familySpeech } from '~/lib/channel/linq/family-outbound';
import { groupCalendarReceipt, groupGmailReceipt } from '~/lib/channel/linq/group-coparent-copy';
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
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import {
  type KidItemClassifier,
  createKidItemClassifier,
  kidRelatedAha,
  loadKidContext,
} from './aha-kids';
import { type AhaSnapshot, failedAha } from './aha-read';
import { type TextConnectProvider, connectorConnectedText } from './text-connect';

/**
 * The text back that ends the texted connect: the parent tapped a link in a thread,
 * granted Google's consent, and gets a sentence in the same thread saying it is done.
 *
 * NO QUIET-HOURS HOLD AND NO F14 GATE, and that is the decision rather than an
 * oversight: this is the receipt for something the parent did ten seconds ago, which is
 * the intake acknowledgment's standing — a parent who taps Connect at 23:10 is owed the
 * answer at 23:10, and the gates exist to stop Hale STARTING a conversation at 23:10.
 *
 * It runs INSIDE the request Google redirected, so it is one insert, one send and one
 * append — nothing that can outlive the redirect the parent is waiting on.
 *
 * Rule #11: every way this ends is named and logged. The done page says "connected"
 * either way, because the connection IS stored by the time this runs — the text is the
 * receipt, not the act, and hiding a failed receipt behind a failed connect would tell
 * the parent the opposite of what is true.
 */

export const CONNECTOR_CONNECTED_TEMPLATE_KEY = 'connector:connected';

/** At most one receipt per CONNECT, enforced by the partial unique index on
 * `channel_messages.dedupe_key`. The id is the connect's own audit row (rule #6), not
 * the integration's: the integration row is upserted on (family, user, provider) and
 * survives a disconnect, so keying on it would silence the receipt for every parent
 * who ever reconnects. */
export function connectorConnectedDedupeKey(connectId: string): string {
  return `${CONNECTOR_CONNECTED_TEMPLATE_KEY}:${connectId}`;
}

export interface ConnectedNoticePorts {
  /** The phone door. Used when the parent's last turn was SMS or WhatsApp. */
  transport: ChannelTransport;
  /**
   * The iMessage door, bound by the caller to an existing Linq chat. Absent
   * is named `imessage_not_configured` when the door is iMessage — never a
   * silent hop onto Twilio.
   */
  imessage?: (input: { chatId: string; body: string }) => Promise<{ providerMessageId: string }>;
  threadMessage: typeof threadProactiveMessage;
  /**
   * Friend voice for the 1:1 receipt when ONBOARDING_FRIEND_VOICE_ENABLED is on.
   * Absent, or a compose that fails, sends nothing canned. The next callback
   * can retry. The group receipt stays the locked sentence: it names the parent.
   */
  friendVoice?: FriendVoiceComposer;
  /**
   * Says which synced items are about the kids before the wow line is written.
   * Absent keeps nothing from the source: the receipt is plain and the reason
   * is logged (aha-kids.ts).
   */
  kidItems?: KidItemClassifier;
}

export type ConnectedNoticeOutcome =
  | { status: 'sent'; channelMessageId: string }
  /** The idempotent no-op: this connection's receipt already went out. */
  | { status: 'not_sent'; reason: 'already_sent' }
  /** No ACTIVE verified SMS channel behind the connecting parent — a connection made
   * from a browser by someone whose number is unverified or STOPped. Nothing is claimed,
   * so a later verified number still earns the receipt. */
  | { status: 'not_sent'; reason: 'no_send_target' }
  /** The last turn was iMessage and no ledger row stored a Linq chat. Nothing is
   * claimed, and nothing is sent on SMS: that would be a second identity. */
  | { status: 'not_sent'; reason: 'no_chat' }
  /** The co-parent's locked group receipt owns this bubble. This path does not
   * also send 1:1 or SMS. */
  | { status: 'not_sent'; reason: 'group_home' }
  /** Friend voice could not write the receipt. The claim is released so a retry can. */
  | { status: 'not_sent'; reason: 'voice_unsent' }
  /** The provider refused it. `code` is Twilio's, or `unknown`. */
  | { status: 'not_sent'; reason: 'send_failed'; code: string }
  /** Something on this path threw — a ledger write, the thread append. Its own outcome
   * and not a `send_failed`, because the throw can land either side of the send: what
   * reached the parent is genuinely unknown, and saying "not sent" would be a guess. */
  | { status: 'errored' };

/** The outcome flattened to one word for the route's log line. */
export type ConnectedNoticeLabel =
  | 'sent'
  | 'already_sent'
  | 'no_send_target'
  | 'no_chat'
  | 'group_home'
  | 'voice_unsent'
  | 'errored'
  | `send_failed:${string}`;

export function connectedNoticeLabel(outcome: ConnectedNoticeOutcome): ConnectedNoticeLabel {
  if (outcome.status === 'sent') return 'sent';
  if (outcome.status === 'errored') return 'errored';
  return outcome.reason === 'send_failed' ? `send_failed:${outcome.code}` : outcome.reason;
}

/** What the callback wires in production. Named here so a test that injects a fake
 * still leaves one path that proves the real transport is reachable. */
export function defaultConnectedNoticePorts(): ConnectedNoticePorts {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client =
    onboardingFriendVoiceEnabled() && apiKey ? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS) : null;
  return {
    transport: createOutboundTransport(),
    imessage: (input) => sendLinqChatMessage({ chatId: input.chatId, text: input.body }),
    threadMessage: threadProactiveMessage,
    friendVoice: client ? createFriendVoiceComposer(client) : undefined,
    kidItems: client ? createKidItemClassifier(client) : undefined,
  };
}

/** The 1:1 receipt. Flag off keeps the locked sentence. Flag on asks the model.
 * A failed compose returns an empty string and the caller does not send it. */
export async function connectedReceiptBody(
  language: ReplyLanguage,
  provider: TextConnectProvider,
  composer: FriendVoiceComposer | undefined,
  aha?: AhaSnapshot | null,
  options?: {
    page?: (text: string) => Promise<unknown>;
    /** The open onboarding, so the receipt knows the parent, the kids and the thread. */
    session?: IntakeSession | null;
    /** The parent's name is already on their row. */
    nameStored?: boolean;
  },
): Promise<string> {
  if (!onboardingFriendVoiceEnabled()) return connectorConnectedText(language, provider);
  const spoken = await speakFriend(
    composer,
    {
      ...receiptVoiceBase(
        language,
        options?.session ?? null,
        provider,
        options?.nameStored ?? false,
      ),
      step: 'connected',
      connector: provider,
      granted: null,
      synced: aha ?? failedAha(provider),
    },
    options?.page ? { page: options.page } : {},
  );
  return spoken.body;
}

export interface ConnectedNoticeArgs {
  familyId: string;
  parentUserId: string;
  provider: TextConnectProvider;
  /** This connect, as `saveConnection` recorded it — the audit row's id. */
  connectId: string;
  now: Date;
  /**
   * Real items from the source that just connected. Friend voice uses them
   * for the one useful line. Absent is a failed read: the model must not invent.
   */
  aha?: AhaSnapshot | null;
}

export async function sendConnectorConnectedText(
  database: Database,
  args: ConnectedNoticeArgs,
  ports: ConnectedNoticePorts,
): Promise<ConnectedNoticeOutcome> {
  try {
    return await sendReceipt(database, args, ports);
  } catch (err) {
    // THE REDIRECT'S BOUNDARY, and the one broad catch here. Google has already handed
    // the parent back and the tokens are already stored; an exception escaping would 500
    // the browser on a connect that DID land, which is the one thing this page must
    // never say. The error's CLASS only (rule #1): the last things this path touches are
    // a phone number and a body.
    console.error(
      {
        familyId: args.familyId,
        provider: args.provider,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'connector connected: the receipt path threw - the connection is stored, what the parent got is unknown',
    );
    return { status: 'errored' };
  }
}

async function sendReceipt(
  database: Database,
  args: ConnectedNoticeArgs,
  ports: ConnectedNoticePorts,
): Promise<ConnectedNoticeOutcome> {
  const { familyId, parentUserId, provider, connectId, now } = args;

  const group = await familyOutboundTarget(database, familyId);
  if (group.channel === 'group') {
    const members = await database
      .select({
        userId: schema.familyMembers.userId,
        role: schema.familyMembers.role,
        familyId: schema.familyMembers.familyId,
      })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    const seat = members.find((row) => row.familyId === familyId && row.userId === parentUserId);
    if (seat?.role === 'co_parent') {
      // The locked group receipt is the one bubble. Do not also text 1:1 or SMS.
      return { status: 'not_sent', reason: 'group_home' };
    }
    return sendGroupHomeReceipt(database, args, ports, group.chatId);
  }

  const phone = await resolveSendablePhone(database, parentUserId);
  if (!phone) {
    console.warn(
      { familyId, provider },
      'connector connected: no sendable channel - the connection is stored but nobody was told',
    );
    return { status: 'not_sent', reason: 'no_send_target' };
  }

  // The door they are standing in. iMessage returns to the stored Linq chat.
  // Anything else goes out through the shared Linq phone transport. A
  // blue-bubble family with no chat id is named and not texted on the other app.
  const door = await resolveMessagingDoor(database, parentUserId);
  const receiptChatId =
    door.channel === 'imessage' && door.chatId
      ? await imessageChatOutsideGroup(database, parentUserId, door.chatId)
      : null;
  if (door.channel === 'imessage' && !receiptChatId) {
    console.warn(
      { familyId, provider },
      'connector connected: last turn was iMessage and no chat id is stored - nobody was told',
    );
    return { status: 'not_sent', reason: 'no_chat' };
  }
  if (door.channel === 'imessage' && !ports.imessage) {
    console.warn(
      { familyId, provider },
      'connector connected: iMessage door has no sender - nobody was told',
    );
    return { status: 'not_sent', reason: 'send_failed', code: 'imessage_not_configured' };
  }
  const channel = door.channel === 'imessage' ? 'imessage' : 'sms';

  // CLAIM FIRST: the unique index is the claim, so "did we already say this?" is
  // answered by the insert rather than by a read a second callback can race.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel,
      direction: 'out',
      // 'reply' rather than 'intake': this answers something the parent just did, and it
      // can happen years after onboarding. It is outside every loop category, so it
      // spends none of a family's nudge budget.
      category: 'reply',
      templateKey: CONNECTOR_CONNECTED_TEMPLATE_KEY,
      dedupeKey: connectorConnectedDedupeKey(connectId),
      providerChatId: door.channel === 'imessage' ? receiptChatId : null,
      status: acceptedStatus(channel),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_sent' };

  if (onboardingFriendVoiceEnabled() && args.aha == null) {
    console.error(
      { familyId, provider },
      'connector connected: aha not supplied - the receipt will not name an event',
    );
  }
  // HARD RULE: the one useful line is about the kids only. Items the
  // classifier does not read as about a child or a kid activity never reach
  // the model. A mailbox or calendar with nothing kid-related yields no mention.
  const session = onboardingFriendVoiceEnabled() ? await openOnboarding(database, familyId) : null;
  const aha =
    onboardingFriendVoiceEnabled() && args.aha
      ? await kidRelatedAha(args.aha, await loadKidContext(database, familyId, now), ports.kidItems)
      : args.aha;
  if (aha && aha.read === 'none_for_kids') {
    console.info({ familyId, provider }, 'connector connected: nothing kid-related to mention');
  }
  const body = await connectedReceiptBody(
    await familyReceiptLanguage(database, familyId),
    provider,
    ports.friendVoice,
    aha,
    {
      session,
      nameStored: await parentNameStored(database, parentUserId),
      page: pageOncePerDay(new PostgresRateLimiter(database), familyId),
    },
  );
  const continuation = {
    familyId,
    parentUserId,
    provider,
    now,
    chatId: door.channel === 'imessage' ? receiptChatId : null,
    phone,
    receipt: body,
  };
  if (body.trim().length === 0) {
    // The wow moment is skipped, not the walk: the next beat still goes out,
    // and the released claim lets a later callback write the receipt.
    await database.delete(schema.channelMessages).where(eq(schema.channelMessages.id, claimed.id));
    console.error({ reason: 'voice_unsent' }, 'connector connected: reply not sent');
    await continueAfterReceipt(database, continuation, ports);
    return { status: 'not_sent', reason: 'voice_unsent' };
  }
  let providerMessageId: string;
  let reportedImessage = false;
  let reportedChatId: string | null = null;
  try {
    if (door.channel === 'imessage') {
      // ports.imessage is present: the guard above returned otherwise.
      const send = ports.imessage;
      if (!send || !receiptChatId) {
        throw new LinqSendError('imessage_not_configured', 0, true);
      }
      ({ providerMessageId } = await send({ chatId: receiptChatId, body }));
    } else {
      const sent = await sendResolvingNewChat(ports.transport, { to: phone, body });
      providerMessageId = sent.providerMessageId;
      if (sent.transport === 'imessage') {
        reportedImessage = true;
        reportedChatId = sent.chatId ?? null;
      }
    }
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    // `not_configured` frees the dedupe key so a later tick can tell them.
    // Every other refusal keeps it (ledger.ts CONSUMED_SEND_STATUSES).
    await database
      .update(schema.channelMessages)
      .set(failedSendPatch(code))
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, provider, code },
      'connector connected: the provider refused the receipt - the connection is stored but nobody was told',
    );
    return { status: 'not_sent', reason: 'send_failed', code };
  }

  await database
    .update(schema.channelMessages)
    .set(
      reportedImessage
        ? {
            providerMessageId,
            channel: 'imessage',
            providerChatId: reportedChatId,
            status: acceptedStatus('imessage'),
          }
        : { providerMessageId },
    )
    .where(eq(schema.channelMessages.id, claimed.id));

  // The sentence Hale said, where the coach reads it back: a parent answering "what did
  // you just connect" must not meet a coach that cannot see its own message.
  await ports.threadMessage(database, { familyId, parentUserId, body });

  await continueAfterReceipt(database, continuation, ports);

  return { status: 'sent', channelMessageId: claimed.id };
}

/**
 * The next onboarding beat rides the receipt. Friend voice on: Gmail first,
 * so its receipt carries the calendar card, and the calendar receipt carries
 * the schedule ask (or the co-parent ask when there is nothing to schedule).
 * Flag off keeps the older order: the Gmail card after the calendar receipt.
 */
async function continueAfterReceipt(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    provider: TextConnectProvider;
    now: Date;
    chatId: string | null;
    phone: string;
    receipt: string;
  },
  ports: ConnectedNoticePorts,
): Promise<void> {
  if (!onboardingFriendVoiceEnabled()) {
    if (args.provider === 'gcal') await sendGmailCardAfterCalendarReceipt(database, args, ports);
    return;
  }
  if (args.provider === 'gmail') {
    await sendCalendarCardAfterGmailReceipt(database, args, ports);
    return;
  }
  if (args.provider === 'gcal') {
    await askAfterCalendarReceipt(database, args, ports);
  }
}

/** Intake stamps this when the kids-and-postal text was French. Anything else is English. */
async function familyReceiptLanguage(database: Database, familyId: string): Promise<ReplyLanguage> {
  const rows = await database
    .select({ id: schema.families.id, primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  const row = rows.find((candidate) => candidate.id === familyId);
  return row?.primaryLanguage === 'fr' ? 'fr' : 'en';
}

/**
 * A primary parent's connect receipt, in the claimed group. Not 1:1, not SMS.
 * The co-parent uses the locked group receipt instead of this sentence.
 */
async function sendGroupHomeReceipt(
  database: Database,
  args: ConnectedNoticeArgs,
  ports: ConnectedNoticePorts,
  chatId: string,
): Promise<ConnectedNoticeOutcome> {
  const { familyId, parentUserId, provider, connectId, now } = args;
  const speech = await familySpeech(database, familyId, parentUserId);
  if (!speech.name || (provider !== 'gcal' && provider !== 'gmail')) {
    return { status: 'not_sent', reason: 'group_home' };
  }
  const body =
    provider === 'gmail'
      ? groupGmailReceipt(speech.language, speech.name)
      : groupCalendarReceipt(speech.language, speech.name);
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: CONNECTOR_CONNECTED_TEMPLATE_KEY,
      dedupeKey: connectorConnectedDedupeKey(connectId),
      providerChatId: chatId,
      status: acceptedStatus('imessage'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_sent' };
  if (!ports.imessage) {
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'imessage_not_configured' })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { status: 'not_sent', reason: 'send_failed', code: 'imessage_not_configured' };
  }
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.imessage({ chatId, body }));
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await database
      .update(schema.channelMessages)
      .set(failedSendPatch(code))
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, provider, code },
      'connector connected: the group refused the receipt',
    );
    return { status: 'not_sent', reason: 'send_failed', code };
  }
  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));
  await ports.threadMessage(database, { familyId, parentUserId, body });
  await continueAfterReceipt(
    database,
    { familyId, parentUserId, provider, now, chatId, phone: '', receipt: body },
    ports,
  );
  return { status: 'sent', channelMessageId: claimed.id };
}

/** The receipt's own door, as a transport the connector card can ride. */
function receiptTransport(
  args: { chatId: string | null },
  ports: ConnectedNoticePorts,
): ChannelTransport {
  return {
    send: async (input) => {
      if (args.chatId && ports.imessage) {
        const sent = await ports.imessage({ chatId: args.chatId, body: input.body });
        return {
          providerMessageId: sent.providerMessageId,
          transport: 'imessage' as const,
          chatId: args.chatId,
        };
      }
      return ports.transport.send(input);
    },
  };
}

/**
 * The Gmail card follows a calendar receipt in the same turn (flag off). The
 * year ladder used to wait for the parent's next text ("Ok") before sending it.
 * A card already sent stays `already_sent`. A failure here does not un-send
 * the receipt.
 */
async function sendGmailCardAfterCalendarReceipt(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    now: Date;
    chatId: string | null;
    phone: string;
  },
  ports: ConnectedNoticePorts,
): Promise<void> {
  try {
    const phone = args.phone || (await resolveSendablePhone(database, args.parentUserId)) || '';
    if (!phone && !args.chatId) {
      console.info(
        { familyId: args.familyId },
        'connector connected: gmail card not sent - no phone and no chat',
      );
      return;
    }
    const language = await familyReceiptLanguage(database, args.familyId);
    const cards = await sendYearConnectorCards(
      database,
      {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        phoneE164: phone || 'unaddressed',
        language,
        now: args.now,
        ridesReply: true,
        only: 'gmail',
      },
      { transport: receiptTransport(args, ports), threadMessage: ports.threadMessage },
    );
    console.info(
      { familyId: args.familyId, gmail: cards.gmail },
      'connector connected: gmail card after the calendar receipt',
    );
  } catch (err) {
    console.error(
      { familyId: args.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'connector connected: gmail card after the calendar receipt failed',
    );
  }
}

/**
 * The calendar card follows the Gmail receipt, in the model's words (step 7 of
 * the onboarding order). The open session, when there is one, remembers that
 * Gmail is connected and that the calendar link went out. A calendar the
 * parent already turned down is not offered again.
 */
async function sendCalendarCardAfterGmailReceipt(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    now: Date;
    chatId: string | null;
    phone: string;
    receipt: string;
  },
  ports: ConnectedNoticePorts,
): Promise<void> {
  try {
    const session = await openOnboarding(database, args.familyId);
    const given = session?.firstTouch?.given ?? null;
    if (given?.connectCalendar === false) {
      await rememberConnected(database, session, { provider: 'gmail', now: args.now });
      console.info(
        { familyId: args.familyId },
        'connector connected: calendar card not sent - they already said no',
      );
      return;
    }
    const phone = args.phone || (await resolveSendablePhone(database, args.parentUserId)) || '';
    if (!phone && !args.chatId) {
      console.info(
        { familyId: args.familyId },
        'connector connected: calendar card not sent - no phone and no chat',
      );
      return;
    }
    const language = await familyReceiptLanguage(database, args.familyId);
    const spoken = await speakFriend(
      ports.friendVoice,
      {
        ...receiptVoiceBase(
          language,
          session,
          'gmail',
          await parentNameStored(database, args.parentUserId),
        ),
        step: 'calendar',
      },
      {
        linkFollows: true,
        page: pageOncePerDay(new PostgresRateLimiter(database), args.familyId),
      },
    );
    if (!spoken.prose.trim() || spoken.source === 'unsent') {
      console.error(
        { familyId: args.familyId },
        'connector connected: calendar card not sent - friend voice unsent',
      );
      await rememberConnected(database, session, { provider: 'gmail', now: args.now });
      return;
    }
    const cards = await sendYearConnectorCards(
      database,
      {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        phoneE164: phone || 'unaddressed',
        language,
        now: args.now,
        ridesReply: true,
        only: 'gcal',
        voice: { gcal: spoken.prose },
      },
      { transport: receiptTransport(args, ports), threadMessage: ports.threadMessage },
    );
    console.info(
      { familyId: args.familyId, calendar: cards.calendar },
      'connector connected: calendar card after the gmail receipt',
    );
    await rememberConnected(database, session, {
      provider: 'gmail',
      now: args.now,
      calendarOffered: cards.calendar === 'sent' || cards.calendar === 'already_sent',
      said: cards.calendar === 'sent' ? spoken.prose : null,
    });
  } catch (err) {
    console.error(
      { familyId: args.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'connector connected: calendar card after the gmail receipt failed',
    );
  }
}

/**
 * After the calendar receipt: the schedule ask when the map has lines and the
 * schedule is still open (step 9), else the co-parent ask when that is still
 * open (step 10). Nothing when the onboarding has no open session. The model
 * writes the ask; code supplies the real lines, the dates it may name, and the
 * join data.
 */
async function askAfterCalendarReceipt(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    now: Date;
    chatId: string | null;
    phone: string;
  },
  ports: ConnectedNoticePorts,
): Promise<void> {
  try {
    const session = await openOnboarding(database, args.familyId);
    if (!session) return;
    const progress = session.firstTouch?.coldStart;
    const given = session.firstTouch?.given ?? null;
    const lines = progress ? linesOfFind(progress.findBody) : [];
    const scheduleOpen = lines.length > 0 && given?.scheduleDone !== true;
    const coparentOpen = given?.coparentGroup == null;
    const step = scheduleOpen ? 'schedule' : coparentOpen ? 'coparent' : null;
    if (!step) {
      await rememberConnected(database, session, { provider: 'gcal', now: args.now });
      return;
    }
    // One ask per session off this receipt. A reconnect does not ask again;
    // the walk continues from the parent's next text.
    const templateKey = step === 'schedule' ? 'onboarding:schedule_ask' : 'onboarding:coparent_ask';
    const [claimed] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        channel: args.chatId ? 'imessage' : 'sms',
        direction: 'out',
        category: 'reply',
        templateKey,
        dedupeKey: `${templateKey}:receipt:${session.id}`,
        providerChatId: args.chatId,
        status: acceptedStatus(args.chatId ? 'imessage' : 'sms'),
        sentAt: args.now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.channelMessages.id });
    if (!claimed) {
      console.info({ familyId: args.familyId, step }, 'connector connected: ask already went out');
      await rememberConnected(database, session, { provider: 'gcal', now: args.now });
      return;
    }
    const language = await familyReceiptLanguage(database, args.familyId);
    // The ask carries no join number: that goes under their yes, in the turn that reads it.
    const spoken = await speakFriend(
      ports.friendVoice,
      {
        ...receiptVoiceBase(
          language,
          session,
          'gcal',
          await parentNameStored(database, args.parentUserId),
        ),
        step,
        findLines: lines,
        findGroups: progress ? groupsFromFindBody(progress.findBody) : [],
        now: args.now,
        coparentJoin: null,
      },
      { page: pageOncePerDay(new PostgresRateLimiter(database), args.familyId) },
    );
    if (spoken.source === 'unsent' || !spoken.body.trim()) {
      await database
        .delete(schema.channelMessages)
        .where(eq(schema.channelMessages.id, claimed.id));
      await rememberConnected(database, session, { provider: 'gcal', now: args.now });
      return;
    }
    const phone = args.phone || (await resolveSendablePhone(database, args.parentUserId)) || '';
    const sent = await receiptTransport(args, ports).send({
      to: phone || 'unaddressed',
      body: spoken.body,
    });
    const channel = sent.transport === 'imessage' ? 'imessage' : 'sms';
    await database
      .update(schema.channelMessages)
      .set({
        channel,
        providerMessageId: sent.providerMessageId,
        providerChatId: sent.chatId ?? args.chatId,
        status: acceptedStatus(channel),
      })
      .where(eq(schema.channelMessages.id, claimed.id));
    await ports.threadMessage(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      body: spoken.body,
    });
    await rememberConnected(database, session, {
      provider: 'gcal',
      now: args.now,
      said: spoken.body,
    });
  } catch (err) {
    console.error(
      { familyId: args.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'connector connected: the ask after the calendar receipt failed',
    );
  }
}

function linesOfFind(message: string): string[] {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ''));
}

/** The onboarding session still open for this family, when the cold start is on it. */
async function openOnboarding(database: Database, familyId: string): Promise<IntakeSession | null> {
  const session = await loadOpenSessionByFamily(database, familyId);
  return session?.firstTouch?.coldStart ? session : null;
}

/**
 * What is already stored, as the in-turn asks see it (machine.ts), so a reply
 * written off a receipt knows the walk's state. The connector that just landed
 * counts as answered before `rememberConnected` writes it down.
 */
function receiptChecklist(
  session: IntakeSession | null,
  connected: TextConnectProvider | null,
  nameStored: boolean,
): OnboardingChecklist | undefined {
  if (!session) return undefined;
  const given = session.firstTouch?.given ?? null;
  const children = session.collected.children;
  const lines = session.firstTouch?.coldStart
    ? linesOfFind(session.firstTouch.coldStart.findBody)
    : [];
  return {
    postal: session.firstTouch?.place != null,
    kids: given?.kidsNamesDeclined === true || kidsAreNamed(children),
    ages: agesAreComplete(children),
    name: nameStored || Boolean(given?.parentName) || given?.nameDeclined === true,
    gmail: connected === 'gmail' || given?.connectGmail != null || given?.gmailLater === true,
    calendar:
      connected === 'gcal' || given?.connectCalendar != null || given?.calendarLater === true,
    schedule: lines.length === 0 || given?.scheduleDone === true,
    coparent: given?.coparentGroup != null,
  };
}

/** The parent's name is on their row: the receipt asks are not the name ask. */
async function parentNameStored(database: Database, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  return !(await parentNeedsName(database, userId));
}

function receiptVoiceBase(
  language: ReplyLanguage,
  session: IntakeSession | null,
  connected: TextConnectProvider | null = null,
  nameStored = false,
) {
  const given = session?.firstTouch?.given ?? null;
  const children = session?.collected.children ?? [];
  const checklist = receiptChecklist(session, connected, nameStored);
  return {
    ...(checklist ? { checklist } : {}),
    language,
    address: 'tu' as const,
    introduce: false,
    parentWords: '',
    recentTurns: (session?.transcript ?? []).slice(-8).map((entry) => ({
      role: entry.direction === 'in' ? ('parent' as const) : ('hale' as const),
      body: entry.body,
    })),
    placeLabel: session?.firstTouch?.place?.city || session?.firstTouch?.place?.areaCoarse || null,
    agesLabel: children.length > 0 ? summarizeChildren(children) : null,
    ageMonths: children.flatMap((child) => (child.ageMonths == null ? [] : [child.ageMonths])),
    children: children.map((child) => ({ name: child.name, ageMonths: child.ageMonths })),
    findLines: [] as string[],
    listKind: 'none' as const,
    activity: null,
    day: null,
    parentName: given?.parentName ?? null,
    parentRole: given?.parentRole ?? null,
    scheduled: (given?.scheduled ?? []).map((row) => ({
      line: row.line,
      title: row.title,
      when: `${row.date}${row.time ? ` ${row.time}` : ''}`,
      cadence: row.cadence,
    })),
  };
}

/**
 * The open session learns what the receipt proved: that connector is on, and
 * what Hale said next, so the next model turn reads it.
 */
async function rememberConnected(
  database: Database,
  session: IntakeSession | null,
  patch: {
    provider: 'gcal' | 'gmail';
    now: Date;
    calendarOffered?: boolean;
    said?: string | null;
  },
): Promise<void> {
  if (!session?.firstTouch) return;
  const given = session.firstTouch.given ?? {
    parentName: null,
    activityPick: null,
    connectCalendar: null,
    connectGmail: null,
  };
  const coldStart = session.firstTouch.coldStart;
  const transcript = patch.said
    ? [
        ...session.transcript,
        {
          direction: 'out' as const,
          body: patch.said,
          providerId: null,
          at: patch.now.toISOString(),
        },
      ]
    : session.transcript;
  await saveSession(
    database,
    session,
    {
      transcript,
      firstTouch: {
        ...session.firstTouch,
        given: {
          ...given,
          connectGmail: patch.provider === 'gmail' ? true : given.connectGmail,
          connectCalendar: patch.provider === 'gcal' ? true : given.connectCalendar,
        },
        ...(coldStart
          ? {
              coldStart: {
                ...coldStart,
                emailAsked: patch.provider === 'gmail' ? true : coldStart.emailAsked,
                emailOffered: patch.provider === 'gmail' ? true : coldStart.emailOffered,
                calendarAsked:
                  patch.provider === 'gcal' || patch.calendarOffered
                    ? true
                    : coldStart.calendarAsked,
                calendarOffered:
                  patch.provider === 'gcal' || patch.calendarOffered
                    ? true
                    : coldStart.calendarOffered,
              },
            }
          : {}),
      },
    },
    patch.now,
  );
}

/**
 * The locked 1:1 receipt stays out of the household group. If the last turn
 * was the group, use a personal Linq chat when one exists. Otherwise the
 * caller names `no_chat` and the group gets only its own receipt.
 */
async function imessageChatOutsideGroup(
  database: Database,
  parentUserId: string,
  doorChatId: string,
): Promise<string | null> {
  const memberships = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, parentUserId));
  const familyIds = memberships
    .filter((row) => row.userId === parentUserId)
    .map((row) => row.familyId);
  const groups = new Set<string>();
  if (familyIds.length > 0) {
    const families = await database
      .select({
        id: schema.families.id,
        linqGroupChatId: schema.families.linqGroupChatId,
      })
      .from(schema.families)
      .where(inArray(schema.families.id, familyIds));
    for (const family of families) {
      if (familyIds.includes(family.id) && family.linqGroupChatId)
        groups.add(family.linqGroupChatId);
    }
  }
  if (!groups.has(doorChatId)) return doorChatId;
  const rows = await database
    .select({
      chatId: schema.channelMessages.providerChatId,
      channel: schema.channelMessages.channel,
      parentUserId: schema.channelMessages.parentUserId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.channel, 'imessage'),
      ),
    );
  const personal = rows.find(
    (row) =>
      row.parentUserId === parentUserId &&
      row.channel === 'imessage' &&
      row.chatId !== null &&
      !groups.has(row.chatId),
  );
  return personal?.chatId ?? null;
}
