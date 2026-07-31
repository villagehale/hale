import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import type { InboundMessage } from '~/lib/channel/intake/transport';
import { twilioConfig } from './config';
import { mediaUnsupportedReply } from './copy';
import { isValidTwilioSignature, parseTwilioParams, twilioWebhookUrl } from './signature';

/**
 * VIL-214 · A3 — the inbound webhook: the ONE door a text from a parent comes through.
 *
 * M2 already built the hard part. `handleInboundSms` owns the order everything rests on
 * (normalize → rate limit → duplicate → CASL keywords → stored state → model), and it
 * has had no caller in production until now — this module is the caller. So A3
 * deliberately does NOT re-implement STOP/HELP/START, rate limiting, or dedupe: a
 * second copy of a CASL guard is a second copy that can drift, and the drifted one is
 * the one that fails a compliance audit.
 *
 * A3 adds exactly the three things the machine cannot see:
 *
 *   1. AUTHENTICATION. The machine trusts its `from`; the webhook must not. Signature
 *      first, before parsing intent or writing anything (see signature.ts).
 *   2. MEDIA. An MMS carries no text the machine can route, so it is answered here —
 *      but only AFTER the keyword check, because a STOP sent with a photo attached is
 *      still a STOP, and answering it with "I can't read attachments" instead of
 *      unsubscribing would be a CASL failure dressed up as a friendly reply.
 *   3. THE HANDOFF. The machine returns `no_open_conversation` for a text from a family
 *      that finished intake — its own comment names this seam as A3's. That is the
 *      conversation C1 will answer, so it is recorded and queued here.
 *
 * The handoff's gate is `resolveVerifiedChannelByPhone`, which resolves only an ACTIVE,
 * verified, non-revoked channel. That is not incidental: it is what makes a stopped
 * number structurally unable to reach C1. A parent who texted STOP has a revoked row,
 * so they resolve to null, so nothing is recorded and nothing is queued — the consent
 * check cannot be forgotten downstream because there is no downstream without it.
 */

export interface ChannelMessageReceivedJob {
  family_id: string;
  parent_user_id: string;
  channel_message_id: string;
  provider_message_id: string;
  received_at: string;
}

export interface TwilioInboundDeps {
  database: Database;
  /**
   * Built LAZILY. Constructing the intake deps reaches for an Anthropic client and a
   * Twilio transport; a forged request must never cause either, so nothing is built
   * until the signature has passed.
   */
  intake: () => IntakeDeps;
  enqueue: (job: ChannelMessageReceivedJob) => Promise<void>;
  now?: () => Date;
}

export type TwilioInboundOutcome =
  /** Authentic, but carrying no sender or no message id — nothing to act on. */
  | 'malformed'
  | 'invalid_number'
  | 'media_unsupported'
  /** The number pressed STOP — nothing is sent to it and nothing is routed. */
  | 'unsubscribed'
  | 'rate_limited'
  /** Recorded and handed to C1's queue. */
  | 'handed_off'
  /** Already recorded under this provider id — a retry, not a second text. */
  | 'duplicate'
  /** The machine handled it; its own outcome is the detail. */
  | 'intake'
  /** No live channel to route to (never enrolled, or unsubscribed). */
  | 'ignored'
  /** A verified channel, but not a parent's — never handed to a household agent. */
  | 'not_a_parent';

/** Twilio's count of attached media parts. Absent/garbage reads as none. */
function mediaCount(params: Record<string, string>): number {
  const parsed = Number.parseInt(params.NumMedia ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Route one authenticated inbound text. Exported so the routing decisions are testable
 * without building an HTTP request; the request shell is
 * {@link handleTwilioInboundRequest}.
 */
export async function routeTwilioInbound(
  deps: TwilioInboundDeps,
  inbound: InboundMessage,
  media: number,
): Promise<TwilioInboundOutcome> {
  const intake = deps.intake();

  // Media is answered here, but never before the CASL keywords: see the module note.
  if (media > 0 && !matchKeyword(inbound.body)) {
    return replyMediaUnsupported(deps.database, inbound, intake);
  }

  const outcome = await handleInboundSms(deps.database, inbound, intake);
  if (outcome.status === 'ignored' && outcome.reason === 'no_open_conversation') {
    return handOffToConversation(deps, inbound);
  }
  return outcome.status === 'ignored' ? 'ignored' : 'intake';
}

/**
 * The MMS answer. Two guards before it can text anyone:
 *
 * CONSENT. A number whose channel is revoked pressed STOP, and this is the one
 * outbound A3 owns outright — so it refuses rather than sending an app link to
 * someone who asked to be left alone (rule #1 / CASL). It would fail anyway once
 * Twilio's opt-out list rejects the send (error 21610), and that failure would throw
 * out of the transport and turn the webhook into a 500 Twilio then retries.
 *
 * RATE. It re-checks the SAME limiter, key, and route the machine uses, so the two
 * paths share one budget rather than each granting its own — otherwise an attacker
 * could double the outbound they can provoke just by attaching a picture.
 */
async function replyMediaUnsupported(
  database: Database,
  inbound: InboundMessage,
  intake: IntakeDeps,
): Promise<TwilioInboundOutcome> {
  const phoneE164 = normalizePhoneE164(inbound.from);
  if (!phoneE164) return 'invalid_number';

  if (await findRevokedChannelOwner(database, phoneE164)) {
    return 'unsubscribed';
  }

  const decision = await intake.limiter.check(
    phoneBlindIndex(phoneE164),
    'sms-inbound',
    RATE_LIMITS['sms-inbound'],
  );
  if (!decision.allowed) return 'rate_limited';

  await intake.transport.send({ to: phoneE164, body: mediaUnsupportedReply() });
  return 'media_unsupported';
}

/**
 * Record a post-intake reply and hand it to C1.
 *
 * TWO gates, and they answer different questions. `resolveVerifiedChannelByPhone` asks
 * "may we talk to this number at all" (active, verified, not revoked — so a STOP can
 * never become a conversation). The ROLE check asks "is this person a parent", which
 * the channel lookup cannot answer: it resolves any household member holding a verified
 * channel, caregivers included.
 *
 * The role gate is a POSITIVE list on purpose. M6 catches caregivers upstream via
 * `isCaregiverRole`, but that is false for the legacy `extended` and `service` roles —
 * the two buckets role-scope.ts gives an EMPTY scope precisely so they fail closed. A
 * negative check would let those fall through to be recorded as `parent_user_id` and
 * handed to an agent that answers with household data. Anyone who is not demonstrably a
 * parent is dropped, so a role we cannot vouch for is silence rather than disclosure.
 *
 * Idempotent on the provider's message id: a webhook retry (Twilio resends when we time
 * out) must not add a second ledger row or a second job. The lookup rides the index A2
 * left on `provider_message_id` for exactly this kind of resolution.
 */
const PARENT_ROLES: readonly string[] = ['primary_parent', 'co_parent'];

async function handOffToConversation(
  deps: TwilioInboundDeps,
  inbound: InboundMessage,
): Promise<TwilioInboundOutcome> {
  const phoneE164 = normalizePhoneE164(inbound.from);
  if (!phoneE164) return 'invalid_number';

  const owner = await resolveVerifiedChannelByPhone(deps.database, phoneE164);
  if (!owner) return 'ignored';

  const members = await deps.database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, owner.userId));
  const member = members.find(
    (row) => row.userId === owner.userId && row.familyId === owner.familyId,
  );
  if (!member || !PARENT_ROLES.includes(member.role)) {
    return 'not_a_parent';
  }

  const seen = await deps.database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, inbound.providerId))
    .limit(1);
  if (seen.length > 0) return 'duplicate';

  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: inbound.providerId,
      status: 'delivered',
      // Inbound bodies ARE stored: this is the parent's own instruction, and C3 treats
      // it as the legal instrument of an approval (the locked A2 contract).
      body: inbound.body,
      sentAt: inbound.receivedAt,
    })
    .returning({ id: schema.channelMessages.id });
  const channelMessageId = row?.id;
  if (!channelMessageId) {
    throw new Error('twilio inbound: channel_messages insert returned no row');
  }

  await deps.database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'sms_reply_received',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  await deps.enqueue({
    family_id: owner.familyId,
    parent_user_id: owner.userId,
    channel_message_id: channelMessageId,
    provider_message_id: inbound.providerId,
    received_at: inbound.receivedAt.toISOString(),
  });
  return 'handed_off';
}

/**
 * Twilio's documented "no reply from this webhook" answer is an empty TwiML
 * `<Response/>` (error 14110's own guidance). Hale's replies go out asynchronously
 * through the REST API, never as TwiML in this response — the webhook must return
 * inside Twilio's 15s budget, and an intake turn can involve a model call.
 */
function emptyTwiml(): Response {
  return new Response('<Response/>', {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

/**
 * `POST /api/channels/twilio/inbound`.
 *
 * Two refusals, in this order and before anything else happens:
 *   503 — the leg is not provisioned. Nothing is parsed, nothing is written, no model
 *         and no provider is touched. Dark by construction rather than by a flag.
 *   403 — the signature does not match. Same: zero side effects.
 * Everything authentic answers 200 with an empty TwiML document, whatever the outcome —
 * a 4xx/5xx would make Twilio retry a message we have already handled.
 */
export async function handleTwilioInboundRequest(
  req: Request,
  deps: TwilioInboundDeps,
): Promise<Response> {
  const config = twilioConfig();
  if (!config) {
    return Response.json({ error: 'twilio_not_configured' }, { status: 503 });
  }

  const params = parseTwilioParams(await req.text());
  const valid = isValidTwilioSignature({
    authToken: config.authToken,
    url: twilioWebhookUrl(req),
    params,
    signature: req.headers.get('x-twilio-signature'),
  });
  if (!valid) {
    return Response.json({ error: 'invalid_signature' }, { status: 403 });
  }

  const from = params.From ?? '';
  const providerId = params.MessageSid ?? params.SmsSid ?? '';
  if (!from || !providerId) {
    return emptyTwiml();
  }

  await routeTwilioInbound(
    deps,
    {
      from,
      body: params.Body ?? '',
      providerId,
      receivedAt: deps.now?.() ?? new Date(),
    },
    mediaCount(params),
  );
  return emptyTwiml();
}
