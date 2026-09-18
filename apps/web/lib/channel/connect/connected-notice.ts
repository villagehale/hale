import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { CONNECTOR_CONNECTED_TEXT, type TextConnectProvider } from './text-connect';

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
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
}

export type ConnectedNoticeOutcome =
  | { status: 'sent'; channelMessageId: string }
  /** The idempotent no-op: this connection's receipt already went out. */
  | { status: 'not_sent'; reason: 'already_sent' }
  /** No ACTIVE verified SMS channel behind the connecting parent — a connection made
   * from a browser by someone whose number is unverified or STOPped. Nothing is claimed,
   * so a later verified number still earns the receipt. */
  | { status: 'not_sent'; reason: 'no_send_target' }
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
  return { transport: createTwilioTransport(), threadMessage: threadProactiveMessage };
}

export interface ConnectedNoticeArgs {
  familyId: string;
  parentUserId: string;
  provider: TextConnectProvider;
  /** This connect, as `saveConnection` recorded it — the audit row's id. */
  connectId: string;
  now: Date;
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

  const phone = await resolveSendablePhone(database, parentUserId);
  if (!phone) {
    console.warn(
      { familyId, provider },
      'connector connected: no sendable channel - the connection is stored but nobody was told',
    );
    return { status: 'not_sent', reason: 'no_send_target' };
  }

  // CLAIM FIRST: the unique index is the claim, so "did we already say this?" is
  // answered by the insert rather than by a read a second callback can race.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      // 'reply' rather than 'intake': this answers something the parent just did, and it
      // can happen years after onboarding. It is outside every loop category, so it
      // spends none of a family's nudge budget.
      category: 'reply',
      templateKey: CONNECTOR_CONNECTED_TEMPLATE_KEY,
      dedupeKey: connectorConnectedDedupeKey(connectId),
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'not_sent', reason: 'already_sent' };

  const body = CONNECTOR_CONNECTED_TEXT[provider];
  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({ to: phone, body }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    // The key STAYS consumed (ledger.ts CONSUMED_SEND_STATUSES): a failed delivery must
    // never un-consume idempotency.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, provider, code },
      'connector connected: the provider refused the receipt - the connection is stored but nobody was told',
    );
    return { status: 'not_sent', reason: 'send_failed', code };
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));

  // The sentence Hale said, where the coach reads it back: a parent answering "what did
  // you just connect" must not meet a coach that cannot see its own message.
  await ports.threadMessage(database, { familyId, parentUserId, body });

  return { status: 'sent', channelMessageId: claimed.id };
}
