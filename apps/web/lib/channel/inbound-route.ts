import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { isCanaryInbound } from '~/lib/channel/canary/config';
import { mediaUnsupportedReply } from '~/lib/channel/inbound-copy';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { type IntakeDeps, type KeywordAck, handleInboundSms } from '~/lib/channel/intake/machine';
import type { InboundMessage } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { liveMemberMayTalk } from '~/lib/channel/linq/group-members';
import { armDelayedImessageTyping } from '~/lib/channel/linq/presence';
import { isParentRole } from '~/lib/channel/role-scope';
import type { MessageTransport } from '~/lib/channel/transport-address';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';

/**
 * The shared inbound router: one authenticated text, the intake machine, then C1.
 * Linq is the only door that calls this. Signature checks live on that door.
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

export interface InboundRouteDeps {
  database: Database;
  /**
   * Built LAZILY. Constructing the intake deps reaches for an Anthropic client and a
   * Linq transport; a forged request must never cause either, so nothing is built
   * until the signature has passed. Told which pipe the message arrived on so an
   * iMessage turn can answer inside that Linq chat. A WhatsApp address never
   * reaches the machine.
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
  countOutcome: (outcome: InboundRouteOutcome) => Promise<void>;
  now?: () => Date;
}

export type InboundRouteOutcome =
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
  /** A new parent's opening turn sent NOTHING: the model could not write it. Never
   * folded into `intake`, which says Hale replied. The session stays owed a reply, and
   * the first-reply sweep (intake/first-reply-recovery.ts) sends it within minutes. */
  | 'intake_unsent'
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
  | 'not_a_parent'
  /** Linq year-find poll: the parent chose "None of these". Recorded, not routed,
   * so this turn does not ask again. A later text still advances the ladder. */
  | 'poll_none'
  /** Linq logistics poll: the vote is stored. It is not routed as a find title. */
  | 'poll_logistics'
  /** Linq location share ended. No text. */
  | 'location_stopped'
  /** Location share arrived while the first-touch ladder is off. No text. */
  | 'location_ignored'
  /** shared_by was an email, not a phone. Not guessed from an area code. */
  | 'location_handle_not_phone'
  /** No open place-ask for this number. No text. */
  | 'location_not_waiting'
  /** The share started but Linq had no city locality yet. No nudge. */
  | 'location_unread'
  /** WhatsApp is retired. The prefix is still recognized so a leftover Twilio
   * webhook is counted and dropped: no ledger row, no keyword, no SMS answer. */
  | 'whatsapp_dropped'
  /** Linq said the sending line is flagged or throttled, or that it recovered. */
  | 'line_health';

/**
 * Route one authenticated inbound text. Exported so the routing decisions are testable
 * without building an HTTP request. Linq's webhook is the request shell.
 */
/**
 * 1:1 intake and cold-start replies are plain bubbles. A reply_to target makes
 * iMessage draw a curved connector under the inbound, which reads as a quote
 * of a first hello. Groups keep the connector: several people are in the thread
 * and the line shows which message Hale is answering.
 */
function linqTurnBind(
  inbound: InboundMessage,
): { chatId: string; replyToMessageId?: string | null } | undefined {
  if (!inbound.chatId) return undefined;
  if (inbound.isGroup === true) {
    return { chatId: inbound.chatId, replyToMessageId: inbound.providerId };
  }
  return { chatId: inbound.chatId };
}

export async function routeInboundText(
  deps: InboundRouteDeps,
  inbound: InboundMessage,
  media: number,
): Promise<InboundRouteOutcome> {
  const typing = armDelayedImessageTyping({
    channel: inbound.transport ?? 'sms',
    chatId: inbound.chatId ?? null,
    log: deps.log,
    delayMs: 0,
  });
  try {
    const intake = {
      ...deps.intake(inbound.transport ?? 'sms', linqTurnBind(inbound)),
      stopTyping: typing.stop,
      keepTyping: typing.rearm,
    };

    // Media is answered here, but never before the CASL keywords: see the module note.
    if (media > 0 && !matchKeyword(inbound.body)) {
      return replyMediaUnsupported(deps.database, inbound, intake);
    }

    const outcome = await handleInboundSms(deps.database, inbound, intake);
    if (outcome.status === 'ignored' && outcome.reason === 'no_open_conversation') {
      await typing.stop();
      return handOffToConversation(deps, inbound);
    }
    if (outcome.status === 'ignored') return 'ignored';
    if (outcome.status === 'first_touch_unsent') {
      deps.log.error(
        { providerMessageId: inbound.providerId, reason: outcome.reason },
        'inbound: a first text got no reply; the first-reply sweep owes it one',
      );
      return 'intake_unsent';
    }
    if (
      outcome.status === 'stopped' ||
      outcome.status === 'helped' ||
      outcome.status === 'restarted'
    ) {
      return keywordOutcome(deps, inbound, outcome.ack);
    }
    return 'intake';
  } finally {
    await typing.stop();
  }
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
  deps: InboundRouteDeps,
  inbound: InboundMessage,
  ack: KeywordAck,
): InboundRouteOutcome {
  if (ack === 'provider_answered') return 'keyword_provider_answered';
  if (ack === 'sent') return 'intake';
  deps.log.error(
    { providerMessageId: inbound.providerId },
    'inbound: re-enrolled this number and the provider permanently refused the acknowledgment — its opt-out list still holds a number our ledger now says is reachable',
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
): Promise<InboundRouteOutcome> {
  const phoneE164 = normalizePhoneE164(inbound.from);
  if (!phoneE164) return 'invalid_number';

  if (await findRevokedChannelOwner(database, phoneE164)) {
    return 'unsubscribed';
  }

  // A family-group turn the Linq door already charged to the chat spends nothing here,
  // exactly as in the machine.
  if (inbound.budget !== 'chat') {
    const decision = await intake.limiter.check(
      phoneBlindIndex(phoneE164),
      'sms-inbound',
      RATE_LIMITS['sms-inbound'],
    );
    if (!decision.allowed) return 'rate_limited';
  }

  if (intake.stopTyping) {
    try {
      await intake.stopTyping();
    } catch (err) {
      console.warn(
        { err: err instanceof Error ? err.name : 'unknown' },
        'linq: typing indicator did not stop',
      );
    }
  }
  const { providerMessageId } = await intake.transport.send({
    to: phoneE164,
    body: mediaUnsupportedReply(),
  });
  // The line just sent is a real outbound: when the number belongs to an enrolled
  // household member, their ledger must show it (rule #6). A stranger's MMS stays
  // unrecorded by structural necessity, not omission — channel_messages.family_id is
  // NOT NULL, so there is no row it could occupy before a family exists.
  // iMessage records the pipe it actually used. An SMS media line stays 'sms'.
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
      throw new Error('inbound: channel_messages insert returned no row');
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
  deps: InboundRouteDeps,
  inbound: InboundMessage,
): Promise<InboundRouteOutcome> {
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
  const groupTalk =
    inbound.isGroup === true &&
    Boolean(inbound.chatId) &&
    (await liveMemberMayTalk(deps.database, owner.familyId, owner.userId, inbound.chatId ?? ''));
  if ((!member || !isParentRole(member.role)) && !groupTalk) {
    return 'not_a_parent';
  }

  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      // The pipe this turn arrived on. iMessage is its own ledger value; SMS is the
      // rest. WhatsApp never reaches this insert.
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
      'inbound: recorded the text but could not queue it for C1 — left unmarked for the reconciler',
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
