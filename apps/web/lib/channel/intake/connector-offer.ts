import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { offerConnectorLinks } from '~/lib/channel/connect/offer';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinqLinkPreview } from '~/lib/channel/linq/link-preview';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import {
  INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
  INTAKE_GMAIL_CARD_TEMPLATE_KEY,
  intakeCalendarCard,
  intakeConnectorOffer,
  intakeGmailCard,
} from './copy';
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
 * made, and the parent who wanted one can say "connect my calendar" at any time. */
export function connectorOfferDedupeKey(familyId: string): string {
  return `${INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY}:${familyId}`;
}

export function calendarCardDedupeKey(familyId: string): string {
  return `${INTAKE_CALENDAR_CARD_TEMPLATE_KEY}:${familyId}`;
}

export function gmailCardDedupeKey(familyId: string): string {
  return `${INTAKE_GMAIL_CARD_TEMPLATE_KEY}:${familyId}`;
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
  /** The message did not reach the parent. `code` is the provider's when the provider
   * refused it, and `unexpected` when something else on this path threw. */
  | { status: 'not_sent'; reason: 'send_failed'; code: string };

type NotSentReason = Extract<ConnectorOfferOutcome, { status: 'not_sent' }>['reason'];

/** The outcome flattened to one word, for the turn's return value and its log line. */
export type ConnectorOfferLabel = 'sent' | NotSentReason;

export function connectorOfferLabel(outcome: ConnectorOfferOutcome): ConnectorOfferLabel {
  return outcome.status === 'sent' ? 'sent' : outcome.reason;
}

export async function sendConnectorOffer(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage;
    now: Date;
    /**
     * The parent just said yes in this chat. The inbox ask is the next text in that
     * conversation, not a later nudge and not a page on /text. Quiet hours do not
     * hold it. Omit this and the night window still suppresses, with no re-drive.
     */
    ridesReply?: boolean;
  },
  ports: ConnectorOfferPorts,
): Promise<ConnectorOfferOutcome> {
  try {
    return await offerConnector(database, args, ports);
  } catch (err) {
    // THE TURN'S BOUNDARY, and the one broad catch on this path. Everything above has
    // already happened: consent written, acknowledgment delivered, and the session
    // about to close. An exception escaping here would 500 the webhook and earn a
    // carrier retry of a completed conversation, which costs the parent a duplicate
    // reply to save them an optional link.
    //
    // The error's CLASS and nothing else (rule #1, as lib/village/intros/voice.ts): the
    // last thing this path touches is the DB write of the body, so the likeliest error
    // to land here is one whose own message quotes what it failed to write — which is a
    // live sign-in link, in a log aggregator.
    console.error(
      { familyId: args.familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'intake connector offer: the offer path threw - this family will not be asked (turn unaffected)',
    );
    return { status: 'not_sent', reason: 'send_failed', code: 'unexpected' };
  }
}

async function offerConnector(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    language: ReplyLanguage;
    now: Date;
    ridesReply?: boolean;
  },
  ports: ConnectorOfferPorts,
): Promise<ConnectorOfferOutcome> {
  const { familyId, parentUserId, now } = args;

  if (
    !args.ridesReply &&
    inProactiveQuietHours(now, await parentTimeZone(database, parentUserId))
  ) {
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
      dedupeKey: null,
      status: 'suppressed_quiet_hours',
    });
    console.warn(
      { familyId },
      'intake connector offer: held for quiet hours - this family is not asked tonight (no re-drive exists)',
    );
    return { status: 'not_sent', reason: 'suppressed_quiet_hours' };
  }

  // CLAIM FIRST, before the mint: the unique index is the claim, so "have we asked
  // this family?" is answered by the insert rather than by a read a retry can race.
  // Claiming before minting also means a lost race mints no token at all.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
      dedupeKey: connectorOfferDedupeKey(familyId),
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_sent' };

  const minted = await offerConnectorLinks(database, {
    familyId,
    parentUserId,
    providers: ['gcal', 'gmail'],
    now,
  });
  if (minted.status !== 'minted') {
    await failClaim(database, claimed.id, minted.status);
    console.warn(
      { familyId, reason: minted.status },
      'intake connector offer: no link to send - this family is not asked (the parent already has their acknowledgment)',
    );
    return { status: 'not_sent', reason: minted.status };
  }

  const [calendarUrl, gmailUrl] = minted.urls;
  const body = intakeConnectorOffer(args.language, calendarUrl, gmailUrl);
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({ to: args.phoneE164, body }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    // The key STAYS consumed (ledger.ts CONSUMED_SEND_STATUSES): a failed delivery must
    // never un-consume idempotency, and a minted token is already loose in the world.
    await failClaim(database, claimed.id, code);
    console.error(
      { familyId, code },
      'intake connector offer: the provider refused the offer - this family will not see the link',
    );
    return { status: 'not_sent', reason: 'send_failed', code };
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));

  // The sentence Hale said, where the coach reads it back: the next text on this number
  // is a C1 turn, and a parent answering "what is this link" must not meet a coach that
  // cannot see it.
  await ports.threadMessage(database, { familyId, parentUserId, body });

  return { status: 'sent', channelMessageId: claimed.id };
}

async function failClaim(database: Database, id: string, errorCode: string): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode })
    .where(eq(schema.channelMessages.id, id));
}

/** The parent's wall clock, off their own users row — post-filtered by id as every
 * reader here is. */
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
    language: ReplyLanguage;
    now: Date;
    ridesReply?: boolean;
  },
  ports: ConnectorOfferPorts,
): Promise<{ calendar: ConnectorOfferLabel; gmail: ConnectorOfferLabel }> {
  if (
    !args.ridesReply &&
    inProactiveQuietHours(args.now, await parentTimeZone(database, args.parentUserId))
  ) {
    for (const templateKey of [INTAKE_CALENDAR_CARD_TEMPLATE_KEY, INTAKE_GMAIL_CARD_TEMPLATE_KEY]) {
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
    return { calendar: 'suppressed_quiet_hours', gmail: 'suppressed_quiet_hours' };
  }

  // ONE mint for both cards. Two calls would be two asks, and the second
  // invalidates the first token — the calendar link is dead before the parent
  // can tap it, which is what a live Linq onboard showed on 2026-09-23.
  const calendarSpec: ConnectorCard = {
    provider: 'gcal',
    templateKey: INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
    dedupeKey: calendarCardDedupeKey(args.familyId),
    render: (url) => intakeCalendarCard(args.language, url),
  };
  const gmailSpec: ConnectorCard = {
    provider: 'gmail',
    templateKey: INTAKE_GMAIL_CARD_TEMPLATE_KEY,
    dedupeKey: gmailCardDedupeKey(args.familyId),
    render: (url) => intakeGmailCard(args.language, url),
  };
  const calendarClaim = await claimConnectorCard(database, args, calendarSpec);
  const gmailClaim = await claimConnectorCard(database, args, gmailSpec);
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

interface ConnectorCard {
  provider: 'gcal' | 'gmail';
  templateKey: string;
  dedupeKey: string;
  render: (url: string) => string;
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
  args: { familyId: string; parentUserId: string; phoneE164: string; now?: Date },
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
  try {
    const body = card.render(url);
    let sent: {
      providerMessageId: string;
      transport?: 'sms' | 'whatsapp' | 'imessage';
      chatId?: string | null;
    };
    try {
      sent = await ports.transport.send({ to: args.phoneE164, body });
    } catch (err) {
      const code =
        err instanceof TwilioSendError || err instanceof LinqSendError ? err.code : 'unknown';
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
    await ports.threadMessage(database, { familyId, parentUserId, body });
    if (carried === 'imessage' && sent.chatId) {
      await sendLinqLinkPreview({
        channel: 'imessage',
        chatId: sent.chatId,
        url,
        database,
        familyId,
        parentUserId,
        now: args.now,
      });
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

async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}
