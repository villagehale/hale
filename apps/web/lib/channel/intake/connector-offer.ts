import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import {
  claimGoogleSend,
  freeGoogleSendKey,
  googleSendGate,
  releaseGoogleClaim,
  sendClaimedGoogleText,
} from '~/lib/channel/connect/google-send-receipt';
import { offerConnectorLinks, offerGoogleBundleLink } from '~/lib/channel/connect/offer';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinkOnce } from '~/lib/channel/linq/link-preview';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { readSendRefusal } from '~/lib/channel/outbound-transport';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { pageOps } from '~/lib/monitoring/failure-page';
import { INTAKE_CALENDAR_CARD_TEMPLATE_KEY, INTAKE_GMAIL_CARD_TEMPLATE_KEY } from './copy';
import type { ChannelTransport } from './transport';

/**
 * The day-one ask: one optional message with a tap-to-connect link for Google Calendar
 * and one for Gmail, sent right after a parent says yes to being watched.
 *
 * IT RIDES THE CONSENT TURN because that turn is the only place the ask is honest. A
 * parent has just agreed to Hale watching for them; the notices they want watched
 * arrive in a mailbox and a calendar Hale cannot see. Asked a week later it is a cold
 * proactive message about permissions; asked here it is the next sentence.
 *
 * IT IS ITS OWN MESSAGE. One text asks one thing: the name ask is the message before
 * this one, and the co-parent ask is the message after. On the consent turn the parent
 * just replied, so that turn passes `ridesReply` and quiet hours do not hold the link.
 * Any other caller still consults quiet hours — a cold permissions link at 22:30 is
 * Hale making noise.
 *
 * ONE LINK PER CONNECTOR, AND BOTH GO STRAIGHT TO GOOGLE: the redeem page signs the
 * parent in and forwards them into that provider's consent, so the portal is not in the
 * path for either. The two tokens are minted in one ask so both are alive when the text
 * lands (channel-signin.ts), and each gets its own audit row naming what was offered.
 *
 * Rule #11: every way this declines is NAMED and logged. Nothing here may fail the
 * turn — the consent is written and the acknowledgment is delivered before this runs,
 * so a throw would hand the carrier a retry of a conversation that is already over.
 *
 * Rule #1: the body carries a live single-use session for fifteen minutes. It is never
 * logged, and neither is the number it went to.
 */

export const INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY = 'intake:connector_offer';

/** At most one offer per family, ever, enforced by the partial unique index on
 * `channel_messages.dedupe_key`. A second link is a second permissions ask nobody
 * made. A parent who wants one later asks in the thread, and Hale mints the link. */
export function connectorOfferDedupeKey(familyId: string): string {
  return `${INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY}:${familyId}`;
}

export function calendarCardDedupeKey(familyId: string): string {
  return `${INTAKE_CALENDAR_CARD_TEMPLATE_KEY}:${familyId}`;
}

export function gmailCardDedupeKey(familyId: string): string {
  return `${INTAKE_GMAIL_CARD_TEMPLATE_KEY}:${familyId}`;
}

/** VIL-721. The one card whose link connects Gmail and the calendar together. */
export const INTAKE_GOOGLE_CARD_TEMPLATE_KEY = 'intake:google_card';

export function googleCardDedupeKey(familyId: string): string {
  return `${INTAKE_GOOGLE_CARD_TEMPLATE_KEY}:${familyId}`;
}

export interface ConnectorOfferPorts {
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
}

export type ConnectorOfferOutcome =
  | { status: 'sent'; channelMessageId: string }
  /** The idempotent no-op: this family has already been asked. */
  | { status: 'not_sent'; reason: 'already_sent' }
  /** Held for the parent's own night. Named on the ledger and never on the dedupe key —
   * a suppression must not spend the one offer this family gets. There is no re-drive:
   * the parent asks for a link whenever they want one. */
  | { status: 'not_sent'; reason: 'suppressed_quiet_hours' }
  /** No sendable verified parent channel behind this user and family. */
  | { status: 'not_sent'; reason: 'not_enrolled' }
  /** The token or its audit row did not land, so there is no link to send. */
  | { status: 'not_sent'; reason: 'mint_failed' }
  /** The model wrote no card prose. There is no fixed fallback, so nothing is sent. */
  | { status: 'not_sent'; reason: 'voice_unsent' }
  /** The message did not reach the parent. `code` is the provider's when the provider
   * refused it, and `unexpected` when something else on this path threw. */
  | { status: 'not_sent'; reason: 'send_failed'; code: string }
  /** VIL-721. A stop, an erasure or a line hold arrived before the send. Nothing went. */
  | { status: 'not_sent'; reason: 'gated' }
  /** VIL-721. The prose reached the parent and its link did not. The offer stays open. */
  | { status: 'not_sent'; reason: 'link_unsent' }
  /**
   * VIL-721. The prose went and the link's send was unclear, so it may have landed. The
   * offer stands: a retry would need a second URL, because a token is unrecoverable once
   * minted (hash-only at rest), and a parent who has no link asks for one in the thread.
   */
  | { status: 'not_sent'; reason: 'link_unconfirmed' }
  /** VIL-721. The turn is in a group chat. The link signs its holder in, so it never goes
   * there: no token is minted, and the family's one offer is not spent. */
  | { status: 'not_sent'; reason: 'group_thread' };

type NotSentReason = Extract<ConnectorOfferOutcome, { status: 'not_sent' }>['reason'];

/** The outcome flattened to one word, for the turn's return value and its log line. */
export type ConnectorOfferLabel = 'sent' | NotSentReason;

export function connectorOfferLabel(outcome: ConnectorOfferOutcome): ConnectorOfferLabel {
  return outcome.status === 'sent' ? 'sent' : outcome.reason;
}

/** A claim whose card did not reach the parent with its link. Its dedupe key is
 * released with it: the key is the family's one offer, and a card that never went
 * has not spent it. */
async function failClaim(database: Database, id: string, errorCode: string): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode, dedupeKey: null })
    .where(eq(schema.channelMessages.id, id));
}

/**
 * Calendar card, then Gmail card. Two texts, one ask each. The links are how the
 * year stays current. A failure of one is named and does not cancel the other.
 */
export async function sendYearConnectorCards(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage | null;
    now: Date;
    ridesReply?: boolean;
    /** One card. The other label is `already_sent` and nothing is minted for it,
     * so a calendar link already in the thread is not invalidated by the Gmail beat. */
    only?: 'gcal' | 'gmail';
    /**
     * Friend-voice prose for a card. The minted URL follows it as its own message.
     * A URL inside the prose is stripped. Absent sends no card.
     */
    voice?: Partial<Record<'gcal' | 'gmail', string>>;
  },
  ports: ConnectorOfferPorts,
): Promise<{ calendar: ConnectorOfferLabel; gmail: ConnectorOfferLabel }> {
  if (
    !args.ridesReply &&
    inProactiveQuietHours(args.now, await parentTimeZone(database, args.parentUserId))
  ) {
    const quietKeys =
      args.only === 'gcal'
        ? [INTAKE_CALENDAR_CARD_TEMPLATE_KEY]
        : args.only === 'gmail'
          ? [INTAKE_GMAIL_CARD_TEMPLATE_KEY]
          : [INTAKE_CALENDAR_CARD_TEMPLATE_KEY, INTAKE_GMAIL_CARD_TEMPLATE_KEY];
    for (const templateKey of quietKeys) {
      await database.insert(schema.channelMessages).values({
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'intake',
        templateKey,
        dedupeKey: null,
        status: 'suppressed_quiet_hours',
      });
    }
    console.warn(
      { familyId: args.familyId },
      'intake connector cards: held for quiet hours - this family is not asked tonight',
    );
    return {
      calendar: args.only === 'gmail' ? 'already_sent' : 'suppressed_quiet_hours',
      gmail: args.only === 'gcal' ? 'already_sent' : 'suppressed_quiet_hours',
    };
  }

  // ONE mint for both cards. Two calls would be two asks, and the second
  // invalidates the first token — the calendar link is dead before the parent
  // can tap it, which is what a live Linq onboard showed on 2026-09-23.
  const calendarSpec: ConnectorCard = {
    provider: 'gcal',
    templateKey: INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
    dedupeKey: calendarCardDedupeKey(args.familyId),
    prose: cardProse(args.voice?.gcal),
  };
  const gmailSpec: ConnectorCard = {
    provider: 'gmail',
    templateKey: INTAKE_GMAIL_CARD_TEMPLATE_KEY,
    dedupeKey: gmailCardDedupeKey(args.familyId),
    prose: cardProse(args.voice?.gmail),
  };
  const calendarClaim =
    args.only === 'gmail' ? null : await claimConnectorCard(database, args, calendarSpec);
  const gmailClaim =
    args.only === 'gcal' ? null : await claimConnectorCard(database, args, gmailSpec);
  const needed = [
    ...(calendarClaim ? [{ spec: calendarSpec, claimId: calendarClaim.id }] : []),
    ...(gmailClaim ? [{ spec: gmailSpec, claimId: gmailClaim.id }] : []),
  ];

  const urls = new Map<'gcal' | 'gmail', string>();
  if (needed.length > 0) {
    const minted = await offerConnectorLinks(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      providers: needed.map((item) => item.spec.provider) as [
        'gcal' | 'gmail',
        ...('gcal' | 'gmail')[],
      ],
      now: args.now,
      // Both unsent: this is a new ask, and older untapped links should die.
      // One already sent: this is the rest of THAT ask. Invalidating would
      // kill the link already in the thread.
      invalidatePrior: needed.length === 2,
    });
    if (minted.status !== 'minted') {
      for (const item of needed) await failClaim(database, item.claimId, minted.status);
      console.warn(
        { familyId: args.familyId, reason: minted.status },
        'intake connector cards: no links to send',
      );
      return {
        calendar: calendarClaim ? minted.status : 'already_sent',
        gmail: gmailClaim ? minted.status : 'already_sent',
      };
    }
    needed.forEach((item, index) => {
      const url = minted.urls[index];
      if (url) urls.set(item.spec.provider, url);
    });
  }

  const calendar = await finishConnectorCard(
    database,
    args,
    ports,
    calendarSpec,
    calendarClaim?.id ?? null,
    urls.get('gcal'),
  );
  const gmail = await finishConnectorCard(
    database,
    args,
    ports,
    gmailSpec,
    gmailClaim?.id ?? null,
    urls.get('gmail'),
  );
  return { calendar, gmail };
}

/**
 * VIL-721. The one card: the model's prose, then ONE link that opens one Google consent
 * asking for Gmail and the calendar together, so the parent taps once and meets
 * Google's unverified-app screen once. The prose is the model's ask, written with that
 * screen as a fact; there is no fixed line, so no prose means no card (`voice_unsent`).
 *
 * Same discipline as the per-provider cards: one claim per family on the dedupe key,
 * quiet hours unless it rides the parent's own reply, every decline named, and a card
 * whose link never went is not a sent card (its claim and key are released).
 */
export async function sendGoogleConnectorCard(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    now: Date;
    ridesReply?: boolean;
    /** Whether this turn's transport is bound to a group chat, where `phoneE164` is ignored. */
    inGroup: boolean;
    /** The model's prose for the ask. Absent or empty sends no card. */
    voice: string | undefined;
  },
  ports: ConnectorOfferPorts,
): Promise<ConnectorOfferLabel> {
  if (args.inGroup) {
    console.info({ familyId: args.familyId }, 'intake google card: not sent into a group chat');
    return 'group_thread';
  }
  if (
    !args.ridesReply &&
    inProactiveQuietHours(args.now, await parentTimeZone(database, args.parentUserId))
  ) {
    await database.insert(schema.channelMessages).values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: INTAKE_GOOGLE_CARD_TEMPLATE_KEY,
      dedupeKey: null,
      status: 'suppressed_quiet_hours',
    });
    console.warn(
      { familyId: args.familyId },
      'intake google card: held for quiet hours - this family is not asked tonight',
    );
    return 'suppressed_quiet_hours';
  }
  const prose = cardProse(args.voice);
  const claimed = await claimGoogleSend(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    channel: 'sms',
    category: 'intake',
    templateKey: INTAKE_GOOGLE_CARD_TEMPLATE_KEY,
    dedupeKey: googleCardDedupeKey(args.familyId),
    providerChatId: null,
    now: args.now,
  });
  if (claimed.kind !== 'try') return 'already_sent';
  const { claim } = claimed;
  const minted = await offerGoogleBundleLink(database, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    now: args.now,
  });
  if (minted.status !== 'minted') {
    await releaseGoogleClaim(database, claim, minted.status);
    console.warn(
      { familyId: args.familyId, reason: minted.status },
      'intake google card: no link to send',
    );
    if (minted.status === 'mint_failed') {
      await pageOps(database, {
        site: 'google_connect_text_unsent',
        facts: { surface: 'card', failure: 'no_link' },
      });
    }
    return minted.status;
  }
  if (prose == null) {
    await releaseGoogleClaim(database, claim, 'voice_unsent');
    await pageOps(database, {
      site: 'connector_link_unwritten',
      facts: { reason: 'write_failed' },
    });
    return 'voice_unsent';
  }
  const outcome = await sendClaimedGoogleText(
    database,
    claim,
    {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      now: args.now,
      channel: 'sms',
      chatId: null,
      surface: 'card',
    },
    (sendKey) => ports.transport.send({ to: args.phoneE164, body: prose, sendKey }),
  );
  if (outcome.status === 'gated') return 'gated';
  if (outcome.status !== 'accepted') {
    console.error(
      { familyId: args.familyId, provider: 'google', code: outcome.code },
      'intake google card: the card did not reach the parent',
    );
    return 'send_failed';
  }
  const carried = outcome.sent.transport === 'imessage' ? 'imessage' : 'sms';
  let linked = false;
  let unconfirmed = false;
  try {
    // The link is its own send: a stop that landed while Linq took the words stops it.
    if ((await googleSendGate(database, args)) !== 'open') {
      await freeGoogleSendKey(database, claim.id);
      await ports.threadMessage(database, {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        body: prose,
      });
      return 'gated';
    }
    const link = await sendLinkOnce({
      transport: ports.transport,
      to: args.phoneE164,
      channel: carried,
      chatId: outcome.sent.chatId ?? null,
      url: minted.url,
      database,
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      now: args.now,
      sendKey: `${claim.id}:link`,
    });
    linked = link.status !== 'not_sent';
    if (link.status === 'not_sent') {
      unconfirmed = link.unconfirmed === true;
      if (!unconfirmed) await freeGoogleSendKey(database, claim.id);
      await recordGoogleLinkUnsent(database, {
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        claimId: claim.id,
        failure: unconfirmed ? 'unconfirmed' : 'refused',
      });
    }
    await ports.threadMessage(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      body: linked ? `${prose}\n${minted.url}` : prose,
    });
  } catch (err) {
    console.error(
      {
        familyId: args.familyId,
        provider: 'google',
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'intake google card: the path after the accepted prose threw',
    );
  }
  if (linked) return 'sent';
  console.error(
    { familyId: args.familyId, provider: 'google' },
    'intake google card: the prose went but the link did not',
  );
  return unconfirmed ? 'link_unconfirmed' : 'link_unsent';
}

async function recordGoogleLinkUnsent(
  database: Database,
  who: {
    familyId: string;
    parentUserId: string;
    claimId: string;
    failure: 'refused' | 'unconfirmed';
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: who.familyId,
    actor: 'system',
    actionTaken: 'google_connect_text_unsent',
    targetTable: 'channel_messages',
    targetId: who.claimId,
    audience: who.parentUserId,
    after: { surface: 'card', failure: who.failure },
  });
  await pageOps(database, {
    site: 'google_connect_text_unsent',
    facts: { surface: 'card', failure: who.failure },
  });
}

/** The model's prose with any URL it wrote dropped; the minted one is sent after it. */
function cardProse(prose: string | undefined): string | null {
  const clean = prose?.replace(/https?:\/\/\S+/g, '').trim();
  // No model prose, no card: there is no fixed fallback line.
  return clean ? clean : null;
}

interface ConnectorCard {
  provider: 'gcal' | 'gmail';
  templateKey: string;
  dedupeKey: string;
  prose: string | null;
}

async function claimConnectorCard(
  database: Database,
  args: { familyId: string; parentUserId: string; now: Date },
  card: ConnectorCard,
): Promise<{ id: string } | null> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: card.templateKey,
      dedupeKey: card.dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: args.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  return claimed ?? null;
}

async function finishConnectorCard(
  database: Database,
  args: { familyId: string; parentUserId: string; phoneE164: string; now: Date },
  ports: ConnectorOfferPorts,
  card: ConnectorCard,
  claimId: string | null,
  url: string | undefined,
): Promise<ConnectorOfferLabel> {
  if (!claimId) return 'already_sent';
  const outcome = await deliverConnectorCard(database, args, ports, card, claimId, url);
  return connectorOfferLabel(outcome);
}

async function deliverConnectorCard(
  database: Database,
  args: { familyId: string; parentUserId: string; phoneE164: string; now: Date },
  ports: ConnectorOfferPorts,
  card: ConnectorCard,
  claimId: string,
  url: string | undefined,
): Promise<ConnectorOfferOutcome> {
  const { familyId, parentUserId } = args;
  if (!url) {
    await failClaim(database, claimId, 'mint_failed');
    return { status: 'not_sent', reason: 'mint_failed' };
  }
  const body = card.prose;
  if (body == null) {
    await failClaim(database, claimId, 'voice_unsent');
    return { status: 'not_sent', reason: 'voice_unsent' };
  }
  try {
    let sent: {
      providerMessageId: string;
      transport?: 'sms' | 'whatsapp' | 'imessage';
      chatId?: string | null;
    };
    try {
      sent = await ports.transport.send({ to: args.phoneE164, body });
    } catch (err) {
      const code = readSendRefusal(err)?.code ?? 'unknown';
      await failClaim(database, claimId, code);
      console.error(
        { familyId, provider: card.provider, code },
        'intake connector card: the provider refused the card',
      );
      return { status: 'not_sent', reason: 'send_failed', code };
    }

    const carried = sent.transport === 'imessage' ? 'imessage' : 'sms';
    await database
      .update(schema.channelMessages)
      .set({
        providerMessageId: sent.providerMessageId,
        channel: carried,
        providerChatId: carried === 'imessage' ? (sent.chatId ?? null) : null,
        status: acceptedStatus(carried),
      })
      .where(eq(schema.channelMessages.id, claimId));
    // VIL-573 · the URL goes once: the preview bubble, or its own text where that is refused.
    const link = await sendLinkOnce({
      transport: ports.transport,
      to: args.phoneE164,
      channel: carried,
      chatId: sent.chatId ?? null,
      url,
      database,
      familyId,
      parentUserId,
      now: args.now,
    });
    const linked = link.status !== 'not_sent';
    if (!linked) {
      await failClaim(database, claimId, 'link_unsent');
    }
    await ports.threadMessage(database, {
      familyId,
      parentUserId,
      body: linked ? `${body}\n${url}` : body,
    });
    if (!linked) {
      console.error(
        { familyId, provider: card.provider, code: link.code },
        'intake connector card: the prose went but the link did not',
      );
      return { status: 'not_sent', reason: 'send_failed', code: 'link_unsent' };
    }
    return { status: 'sent', channelMessageId: claimId };
  } catch (err) {
    console.error(
      {
        familyId,
        provider: card.provider,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'intake connector card: the card path threw',
    );
    return { status: 'not_sent', reason: 'send_failed', code: 'unexpected' };
  }
}

/** The parent's wall clock, off their own users row — post-filtered by id as every
 * reader here is. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}
