import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { isCanaryInbound } from '~/lib/channel/canary/config';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { type IntakeKeyword, matchKeyword } from '~/lib/channel/intake/keywords';
import { type IntakeDeps, type KeywordAck, handleInboundSms } from '~/lib/channel/intake/machine';
import type { InboundMessage } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { isParentRole } from '~/lib/channel/role-scope';
import { type MessageTransport, parseTransportAddress } from '~/lib/channel/transport-address';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { twilioConfig } from './config';
import { mediaUnsupportedReply } from './copy';
import { isValidTwilioSignature, parseTwilioParams, twilioWebhookUrl } from './signature';

/**
 * VIL-214 · A3 — the inbound webhook: the ONE door a text from a parent comes through.
 *
 * M2 already built the hard part. `handleInboundSms` owns the order everything rests on
 * (normalize → read the keyword → rate limit → duplicate → act on the keyword → stored
 * state → model), and it
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
   * until the signature has passed. Told which pipe the message arrived on so the
   * reply transport can ride it back (WhatsApp within its session, SMS otherwise —
   * reply-transport.ts). An iMessage turn also passes the Linq chat id, because the
   * within-request reply (STOP, the media line) has to return to that chat.
   */
  intake: (
    inboundTransport: MessageTransport,
    linq?: { chatId: string; replyToMessageId?: string | null },
  ) => IntakeDeps;
  enqueue: (job: ChannelMessageReceivedJob) => Promise<void>;
  /** Required, not optional: the one thing that must never happen quietly here is a
   * text Hale accepted and never queued (rule #11). `info` carries the one routed-
   * outcome line every authentic request ends with — ids and enums, never a body. */
  log: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Count one authentic request's FINAL outcome (PostHog, no PII — see
   * captureInboundRouted). Required (rule #11): the silence outcomes — rate_limited,
   * ignored, not_a_parent, malformed — are only distinguishable from "nobody texts
   * us" if every one of them is written down as a rate. Wired to a counter that
   * never throws; a refused count must not take the webhook down. */
  countOutcome: (outcome: TwilioInboundOutcome) => Promise<void>;
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
  /** The same, for the synthetic probe household (channel/canary/config.ts). Its own
   * value so the routed rates stay a measure of REAL traffic: the canary hands off on
   * a clock, and folding its turns into `handed_off` would swamp the one denominator
   * that says how much of what parents send Hale actually answers. */
  | 'handed_off_canary'
  /** Recorded, but the queue refused it: the row is left unmarked for the reconciler,
   * and the parent is owed a reply Hale has not yet given. Never folded into
   * `handed_off` — that value is a claim that C1 has the text. */
  | 'enqueue_failed'
  /** Already recorded under this provider id — a retry, not a second text. */
  | 'duplicate'
  /** The machine handled it; its own outcome is the detail. */
  | 'intake'
  /** VIL-348 — a CASL keyword turn the machine did in full while sending NOTHING,
   * because the provider's own keyword handling had already answered the sender. Kept
   * out of `intake` because that value says Hale replied: the rate of this one is the
   * only measure, anywhere, of how much of the French/English keyword experience the
   * provider's configuration is actually carrying. */
  | 'keyword_provider_answered'
  /** VIL-348 — the machine did every consent write and the provider then PERMANENTLY
   * refused Hale's own acknowledgment (21610 above all: an opt-out list that still holds
   * a number whose owner has just re-enrolled). The ledger says reachable and the number
   * is not. Never folded into `intake` (rule #11): before this it was, and a webhook that
   * answers 200 was then the only trace of a household Hale can no longer text. */
  | 'keyword_ack_refused'
  /** No live channel to route to (never enrolled, or unsubscribed). */
  | 'ignored'
  /** Linq only: a delivered, read, or failed receipt was applied to the ledger
   * (or logged when no row carries that provider id). Counted on its own so a
   * receipt is not an ignored text. SMS never produces this. */
  | 'receipt'
  /** A verified channel, but not a parent's — never handed to a household agent. */
  | 'not_a_parent';

/** Twilio's count of attached media parts. Absent/garbage reads as none. */
function mediaCount(params: Record<string, string>): number {
  const parsed = Number.parseInt(params.NumMedia ?? '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Twilio's own name for each keyword it answered, as `OptOutType` carries it. */
const OPT_OUT_TYPES: Record<string, IntakeKeyword> = {
  STOP: 'stop',
  START: 'start',
  HELP: 'help',
};

/**
 * VIL-348 — whether the provider already answered this message itself.
 *
 * Twilio's Advanced Opt-Out, when it is configured on the Messaging Service, matches its
 * own keyword list, sends its own reply, and tags the forwarded inbound `OptOutType`.
 * Reading it here is the ONLY way that fact enters Hale: nothing else in the system can
 * see the account's configuration, which is precisely how the comment this ticket
 * deleted managed to be wrong for four weeks.
 *
 * ABSENT IS A NAMED ANSWER, not an unknown (rule #11): the provider answered nothing.
 * That is also what an unrecognised value resolves to — Hale suppressing its own CASL
 * reply on the strength of a token it does not understand is the worse failure of the
 * two. The value itself is never logged, only the fact that one arrived: it rides beside
 * a phone number and a message body on this request (rule #1).
 */
function providerAnsweredKeyword(
  params: Record<string, string>,
  log: Pick<Console, 'warn'>,
): IntakeKeyword | null {
  const raw = params.OptOutType;
  if (!raw) return null;
  const known = OPT_OUT_TYPES[raw.trim().toUpperCase()];
  if (!known) {
    log.warn(
      { length: raw.length },
      'twilio inbound: unrecognised OptOutType — answering the keyword ourselves',
    );
    return null;
  }
  return known;
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
  const intake = deps.intake(
    inbound.transport ?? 'sms',
    inbound.chatId ? { chatId: inbound.chatId, replyToMessageId: inbound.providerId } : undefined,
  );

  // Media is answered here, but never before the CASL keywords: see the module note.
  if (media > 0 && !matchKeyword(inbound.body)) {
    return replyMediaUnsupported(deps.database, inbound, intake);
  }

  const outcome = await handleInboundSms(deps.database, inbound, intake);
  if (outcome.status === 'ignored' && outcome.reason === 'no_open_conversation') {
    return handOffToConversation(deps, inbound);
  }
  if (outcome.status === 'ignored') return 'ignored';
  if (
    outcome.status === 'stopped' ||
    outcome.status === 'helped' ||
    outcome.status === 'restarted'
  ) {
    return keywordOutcome(deps, inbound, outcome.ack);
  }
  return 'intake';
}

/**
 * VIL-348 — what became of HALE'S OWN acknowledgment, carried out through the door.
 *
 * The machine names it (`KeywordAck`), and this is the only place that name can reach an
 * operator: the webhook answers Twilio with an empty document whatever happens, so the
 * routed line and its counter are the entire observable surface of an inbound text. A
 * `provider_refused` flattened to `intake` — which is what this door did before — is a
 * household whose ledger says enrolled, whose number the provider will not accept, and
 * whose only trace is a 200 (rule #11).
 *
 * The refusal is also the one of the three that is ACTIONABLE, and the action is not in
 * this codebase: the provider's localized keyword set has to hold every word Hale prints
 * (intake/keywords.ts). So it is logged at error level beside the enqueue failure, the
 * other outcome that means a parent is owed something Hale has not delivered.
 */
function keywordOutcome(
  deps: TwilioInboundDeps,
  inbound: InboundMessage,
  ack: KeywordAck,
): TwilioInboundOutcome {
  if (ack === 'provider_answered') return 'keyword_provider_answered';
  if (ack === 'sent') return 'intake';
  deps.log.error(
    { providerMessageId: inbound.providerId },
    'twilio inbound: re-enrolled this number and the provider permanently refused the acknowledgment — its opt-out list still holds a number our ledger now says is reachable',
  );
  return 'keyword_ack_refused';
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

  const { providerMessageId } = await intake.transport.send({
    to: phoneE164,
    body: mediaUnsupportedReply(),
  });
  // The line just sent is a real outbound: when the number belongs to an enrolled
  // household member, their ledger must show it (rule #6). A stranger's MMS stays
  // unrecorded by structural necessity, not omission — channel_messages.family_id is
  // NOT NULL, so there is no row it could occupy before a family exists.
  // iMessage records the pipe it actually used. WhatsApp's media line still rides
  // SMS (the reply transport's media rule) and keeps the historical 'sms' row.
  const ledgerChannel = inbound.transport === 'imessage' ? 'imessage' : 'sms';
  const owner = await resolveVerifiedChannelByPhone(database, phoneE164);
  if (owner) {
    const now = intake.now ?? inbound.receivedAt;
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: owner.familyId,
        parentUserId: owner.userId,
        channel: ledgerChannel,
        direction: 'out',
        category: 'reply',
        providerMessageId,
        providerChatId: inbound.transport === 'imessage' ? (inbound.chatId ?? null) : null,
        status: acceptedStatus(ledgerChannel),
        body: null,
        // A fixed line that answered instead of the coach — the same vocabulary the
        // router's deflection replies persist (migration 0103).
        replySource: 'fixed',
        sentAt: now,
      })
      .returning({ id: schema.channelMessages.id });
    const channelMessageId = row?.id;
    if (!channelMessageId) {
      throw new Error('twilio inbound: channel_messages insert returned no row');
    }
    await database.insert(schema.auditLog).values({
      familyId: owner.familyId,
      actor: owner.userId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: channelMessageId,
    });
  }
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
 * Idempotent on the provider's message id, and the INSERT is what makes it so. Twilio
 * resends when we exceed its 15s budget, so the resend can arrive while this handler is
 * still running: a select-then-insert guard is a guard both deliveries walk straight
 * through. The unique index on `provider_message_id` where `direction = 'in'` decides it
 * in the database instead — exactly one request wins the row, and winning the row is what
 * confers the right (and the duty) to enqueue.
 *
 * `handed_off_at` is then the answer to a DIFFERENT question: not "have we seen this
 * text" but "does C1 actually have it". Those were one question before, and that is how a
 * failed enqueue swallowed a parent's approval forever — the ledger row committed, the
 * enqueue threw, and every Twilio retry found the row and answered 'duplicate'. The mark
 * is written only after the job really exists, so a row left null is a text still owed a
 * reply, and `reconcileUnhandedInbound` (queue-maintenance cron) is what re-drives it.
 * Nothing re-drives it inside the request: a retry arriving seconds later cannot tell a
 * dead attempt from one still in flight, and the reconciler can, because it uses age.
 */
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
  if (!member || !isParentRole(member.role)) {
    return 'not_a_parent';
  }

  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      // The REAL pipe (WhatsApp v1). The reply-destination decision reads this row
      // back to honor Meta's 24h session window, and the reconciler's select names
      // both transports — a WhatsApp turn recorded as 'sms' would be re-driven down
      // the wrong leg and lie in a right-to-access export.
      channel: inbound.transport ?? 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: inbound.providerId,
      providerChatId: inbound.chatId ?? null,
      status: 'delivered',
      // Inbound bodies ARE stored: this is the parent's own instruction, and C3 treats
      // it as the legal instrument of an approval (the locked A2 contract).
      body: inbound.body,
      sentAt: inbound.receivedAt,
    })
    .onConflictDoNothing({
      target: schema.channelMessages.providerMessageId,
      where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  // No row means another delivery of this same MessageSid won the claim. It owns the
  // hand-off; a second job here would be a second reply to one text.
  const channelMessageId = row?.id;
  if (!channelMessageId) return 'duplicate';

  await deps.database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'sms_reply_received',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  try {
    await deps.enqueue({
      family_id: owner.familyId,
      parent_user_id: owner.userId,
      channel_message_id: channelMessageId,
      provider_message_id: inbound.providerId,
      received_at: inbound.receivedAt.toISOString(),
    });
  } catch (err) {
    // The ids an operator can act on, and nothing the parent typed (rule #1).
    deps.log.error(
      {
        channelMessageId,
        providerMessageId: inbound.providerId,
        err: err instanceof Error ? err.message : String(err),
      },
      'twilio inbound: recorded the text but could not queue it for C1 — left unmarked for the reconciler',
    );
    return 'enqueue_failed';
  }

  // Only now is the message really C1's. An enqueue that failed leaves this null and the
  // reconciler picks it up; marking before the enqueue would re-create the exact bug
  // this column exists to end.
  await deps.database
    .update(schema.channelMessages)
    .set({ handedOffAt: deps.now?.() ?? new Date() })
    .where(eq(schema.channelMessages.id, channelMessageId));

  // Pure, over the canonical `From` the door already holds: a label computed
  // after the row, the audit and the enqueue have committed must not be able to
  // fail the hand-off it is labelling.
  return isCanaryInbound(phoneE164) ? 'handed_off_canary' : 'handed_off';
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

  // THE boundary strip (WhatsApp v1): `From=whatsapp:+1416…` is the same person as
  // `From=+1416…`, so the prefix comes off HERE — once — and the entire spine
  // (normalize → blind index → resolve → keywords → machine → C1) runs on the bare
  // number unchanged. The pipe travels beside the address, never inside it.
  const { transport, address } = parseTransportAddress(params.From ?? '');
  const providerId = params.MessageSid ?? params.SmsSid ?? '';
  if (!address || !providerId) {
    // Signature-valid but carrying no sender or no message id: if this ever fires, a
    // real message just vanished — so it is the one outcome logged at error level.
    // Field PRESENCE only, never the values (From is a phone number, rule #1).
    deps.log.error(
      { hasFrom: Boolean(address), hasProviderId: Boolean(providerId) },
      'twilio inbound: malformed — authentic POST with no sender or no message id, nothing to act on',
    );
    await deps.countOutcome('malformed');
    return emptyTwiml();
  }

  const outcome = await routeTwilioInbound(
    deps,
    {
      from: address,
      transport,
      body: params.Body ?? '',
      providerId,
      receivedAt: deps.now?.() ?? new Date(),
      providerAnsweredKeyword: providerAnsweredKeyword(params, deps.log),
    },
    mediaCount(params),
  );
  // The one line every authentic text ends with, and its counter twin. The provider
  // message id is Twilio's envelope handle, already the id every other log line here
  // carries — never the number, never the body (rule #1).
  //
  // `optOutTypePresent` is the fact that no code can otherwise establish (VIL-348):
  // whether the provider's own keyword handling tagged this request at all. PRESENCE,
  // including a value Hale did not recognise — the outcome above says what was DONE with
  // it, and the two together are what the live probe reads back to learn which
  // configuration is really running.
  deps.log.info(
    { outcome, providerMessageId: providerId, optOutTypePresent: Boolean(params.OptOutType) },
    'twilio inbound: routed',
  );
  await deps.countOutcome(outcome);
  return emptyTwiml();
}
