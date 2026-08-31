import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { MessageTransport } from '~/lib/channel/transport-address';
import { twilioWhatsAppSender } from '~/lib/channel/twilio/config';

/**
 * WhatsApp v1 — the reply-destination seam: which pipe answers a parent.
 *
 * The rule is Meta's, not ours, and it is why WhatsApp stays a REPLY transport
 * only: a business may free-form message a person solely inside the 24-hour
 * customer-service window their own last message opened. Outside it (Twilio 63016)
 * or before the sender is provisioned, the answer rides SMS to the same number —
 * degrade to the working transport, never to silence — and every fallback carries
 * a NAME (rule #11). Proactive lanes never come through here at all: the dispatch
 * refuses a whatsapp leg outright (channel/dispatch.ts).
 *
 * "Last inbound" is read from the channel_messages ledger, which the webhook now
 * stamps with the real transport (twilio/inbound.ts) — the same rows a PIPEDA
 * right-to-access export is built from, so the decision is auditable against the
 * exact fact it used.
 */

/** Meta's customer-service window: free-form replies are allowed strictly less
 * than 24h after the parent's last WhatsApp message. At exactly 24h the send
 * would earn Twilio's 63016 refusal, so the boundary itself is outside. */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Why an answer is riding SMS. Never folded together: 'not_configured' is the
 * dark launch, 'window_expired' is Meta policy, 'no_whatsapp_history' is simply a
 * parent who texts. */
export type SmsFallbackReason = 'not_configured' | 'no_whatsapp_history' | 'window_expired';

export type ReplyTransportDecision =
  | { transport: 'whatsapp' }
  | { transport: 'sms'; reason: SmsFallbackReason };

export interface LastInboundMessage {
  transport: MessageTransport;
  receivedAt: Date;
}

/** The decision, pure: configuration first (unconfigured is SMS unconditionally —
 * the map's degrade contract), then the parent's own last inbound, then the window. */
export function selectReplyTransport(input: {
  configured: boolean;
  lastInbound: LastInboundMessage | null;
  now: Date;
}): ReplyTransportDecision {
  if (!input.configured) return { transport: 'sms', reason: 'not_configured' };
  if (input.lastInbound === null || input.lastInbound.transport !== 'whatsapp') {
    return { transport: 'sms', reason: 'no_whatsapp_history' };
  }
  const age = input.now.getTime() - input.lastInbound.receivedAt.getTime();
  if (age >= WHATSAPP_SESSION_WINDOW_MS) {
    return { transport: 'sms', reason: 'window_expired' };
  }
  return { transport: 'whatsapp' };
}

/**
 * The newest thing this parent sent on a phone transport, whichever pipe it rode.
 * `sentAt` is the received time on inbound rows (the webhook writes it); createdAt
 * is the fallback for any row born without one. Post-filtered and post-sorted in
 * code as defense in depth, the module habit every channel reader keeps.
 */
export async function loadLastInboundTransport(
  database: Database,
  userId: string,
): Promise<LastInboundMessage | null> {
  const rows = await database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      channel: schema.channelMessages.channel,
      direction: schema.channelMessages.direction,
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, userId),
        eq(schema.channelMessages.direction, 'in'),
        inArray(schema.channelMessages.channel, ['sms', 'whatsapp']),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(50);

  const inbound = rows
    .filter(
      (row) =>
        row.parentUserId === userId &&
        row.direction === 'in' &&
        (row.channel === 'sms' || row.channel === 'whatsapp'),
    )
    .map((row) => ({
      transport: row.channel as MessageTransport,
      receivedAt: row.sentAt ?? row.createdAt,
    }))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return inbound[0] ?? null;
}

/**
 * The decider the channel router's transport is bound with (router/wiring.ts): the
 * recipient's number back to its verified owner, the owner to their last inbound,
 * the last inbound to a decision. An unresolvable number is 'no_whatsapp_history'
 * — the router only ever answers a resolved parent, so this is belt-and-braces,
 * and SMS is the only pipe with any standing for a number we cannot vouch for.
 */
export function createOwnerReplyDecider(
  database: Database,
  opts: { now?: () => Date; configured?: () => boolean } = {},
): (to: string) => Promise<ReplyTransportDecision> {
  const now = opts.now ?? (() => new Date());
  const configured = opts.configured ?? (() => twilioWhatsAppSender() !== null);
  return async (to) => {
    if (!configured()) return { transport: 'sms', reason: 'not_configured' };
    const owner = await resolveVerifiedChannelByPhone(database, to);
    if (!owner) return { transport: 'sms', reason: 'no_whatsapp_history' };
    const lastInbound = await loadLastInboundTransport(database, owner.userId);
    return selectReplyTransport({ configured: true, lastInbound, now: now() });
  };
}

export interface ReplyTransportDeps {
  sms: ChannelTransport;
  whatsapp: ChannelTransport;
  decide: (to: string) => Promise<ReplyTransportDecision>;
}

/**
 * One `ChannelTransport` over both pipes. The result NAMES the pipe that carried
 * the send, so the caller's ledger row records what happened rather than what it
 * assumed (`sendReply` in router/route.ts, the intake machine's entries via deps).
 *
 * Media rides SMS unconditionally: the WhatsApp leg refuses media (its transport
 * throws — text/vcard over Twilio WhatsApp is unverified territory), and the
 * OutboundMessage contract forbids dropping an attachment. The SAME number gets
 * the card by SMS — delivered on the capable pipe, not silently withheld.
 */
export function createReplyTransport(deps: ReplyTransportDeps): ChannelTransport {
  return {
    async send(input) {
      if (input.mediaUrls) {
        const { providerMessageId } = await deps.sms.send(input);
        return { providerMessageId, transport: 'sms' };
      }
      const decision = await deps.decide(input.to);
      const carrier = decision.transport === 'whatsapp' ? deps.whatsapp : deps.sms;
      const { providerMessageId } = await carrier.send(input);
      return { providerMessageId, transport: decision.transport };
    },
  };
}
