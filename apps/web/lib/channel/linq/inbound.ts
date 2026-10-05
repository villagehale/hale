import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import type { RequestIntentReader } from '~/lib/channel/connect/request-intent';
import { answerParentDutyAsk } from '~/lib/channel/coparent/duty/asks';
import { coparentDutyAsksArmed } from '~/lib/channel/coparent/duty/flag';
import { settleDutyMemory } from '~/lib/channel/coparent/duty/settle';
import { shadowTapbackIfDuty, shadowWhenArmed } from '~/lib/channel/coparent/duty/shadow';
import { applyDeliveryStatus } from '~/lib/channel/delivery-status';
import {
  type InboundRouteDeps,
  type InboundRouteOutcome,
  routeInboundText,
} from '~/lib/channel/inbound-route';
import { firstTouchLadderEnabled } from '~/lib/channel/intake/first-touch-flag';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { loadOpenSession } from '~/lib/channel/intake/session';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { socialWatchlistEnabled } from '~/lib/social/flag';
import { considerSocialForward } from '~/lib/social/forward';
import {
  linqFromE164,
  linqGroupCoparentEnabled,
  linqGroupMembersEnabled,
  linqInboundConfigured,
  linqMissingInboundEnv,
  linqMultiFamilyGroupsEnabled,
  linqWebhookSecret,
} from './config';
import {
  LINQ_GROUP_CLAIMED_TEMPLATE_KEY,
  LINQ_GROUP_CLAIM_REFUSED_TEMPLATE_KEY,
  LINQ_GROUP_CLAIM_REFUSED_TEXT,
  LINQ_GROUP_LINE_MISSING_TEXT,
  LINQ_GROUP_OPEN_TEXT,
  LINQ_GROUP_TRIGGER_1TO1_TEMPLATE_KEY,
  claimHouseholdLinqGroup,
  deliverLinqGroupNotice,
  familyOwnsLinqGroupChat,
  formatLinqLineForParent,
  holdUnknownGroupSender,
  linqGroupTriggerInOneToOne,
  mapGroupHandlesToFamily,
  matchLinqGroupTrigger,
} from './group';
import {
  type GroupCoparentPorts,
  considerGroupCoparent,
  firstSeatableHandle,
  seatAppearingCoparent,
  steerNotedCoparentOneToOne,
  welcomeSeatedCoparent,
} from './group-coparent';
import {
  holdTrueStrangerOnce,
  seatParticipantAdded,
  shouldHoldGroupStranger,
  unseatParticipantRemoved,
} from './group-members';
import type { GroupVoice } from './group-voice';
import { captureLogisticsText } from './household-calendar';
import { readSharedLocality } from './location-share';
import { isLogisticsPollKind, recordLogisticsVote } from './logistics-poll';
import { takeMultiFamilyTurn, unseatMultiFamilyMember } from './multi-family';
import {
  type LinqInboundText,
  type LinqLocationSignal,
  type LinqSignal,
  parseLinqWebhook,
} from './payload';
import { isYearFindPollNone, lookupLinqPollOption } from './poll';
import { LINQ_WEBHOOK_VERSION, verifyLinqWebhookSignature } from './signature';
import { type LinqEffectResult, markLinqChatRead } from './transport';

/**
 * VIL-335 — POST /api/channels/linq/inbound.
 *
 * The same conversation the SMS door already runs. Signature first, then the
 * pinned payload version, then `routeInboundText`: normalize the sender
 * handle, resolve it on the phone blind index, and hand a finished intake off
 * to C1. The person is not forked. The pipe is recorded as `imessage`, with the
 * Linq chat id on the row, so the router's reply goes back into that chat.
 *
 * A missing secret or API key is `linq_not_configured` (503). Nothing is parsed
 * and nothing is written. Linq retries a 503, so a secret that lands inside the
 * retry window still delivers the text.
 *
 * A group chat is the household year only after Hale writes
 * `families.linq_group_chat_id`. The parent starts the group and sends the
 * trigger; that write is the claim. A group that is not claimed yet is not
 * handed to the coach. An unknown number is held and not enrolled.
 * Linq group co-parent seating is on unless `LINQ_GROUP_COPARENT=off`. The
 * second real person in a claimed group is seated on that family. No prior
 * phone is required. SMS does not read the flag.
 * Reactions, typing, and participant events answer 200. A poll vote for a
 * find title becomes that title and enters the same router a typed reply
 * would. "None of these" is recorded and not routed, so that turn asks nothing.
 *
 * Outbound echoes and events this door does not act on answer 200 with a
 * named outcome. A 4xx/5xx would make Linq retry work this door is declining
 * on purpose.
 *
 * A 1:1 `message.received` is marked read on Linq before the turn finishes
 * thinking. That call is best-effort: a refusal is logged and the reply still
 * goes out. Group chats are not marked — Linq delivers nothing there.
 *
 * `message.delivered`, `message.read`, and `message.failed` are the exception:
 * they update the outbound ledger row (the same monotonic write Twilio's
 * status callback uses) and answer 200 either way. `unknown_message` is
 * logged. A read is stored as delivered — the status enum has no further
 * state — and the log line keeps the event name so pacing can tell them apart.
 */

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export async function handleLinqInboundRequest(
  req: Request,
  deps: InboundRouteDeps & {
    /** Test seam. Production calls Linq. A miss is logged and never fails the turn. */
    markRead?: (input: { chatId: string }) => Promise<LinqEffectResult>;
    /** Test seam for the unknown-sender hold. Production texts the group. */
    holdGroup?: (input: { chatId: string }) => Promise<'sent' | 'not_sent'>;
    /**
     * Test seam for a claim ack or a 1:1 trigger nudge. Production sends
     * through Linq inside {@link deliverLinqGroupNotice}.
     */
    sendGroupText?: (input: { chatId: string; text: string }) => Promise<{
      providerMessageId: string;
    }>;
    /** The group's model voice (group-voice.ts). Absent falls back to the production composer. */
    groupVoice?: GroupVoice;
    /**
     * The reader of what a seated parent's message asks for (connect/request-intent.ts).
     * Absent falls back to the production reader.
     */
    requestIntentReader?: RequestIntentReader;
    /** Test seam. Production reads Linq and keeps the street address inside that door. */
    readSharedLocality?: typeof readSharedLocality;
  },
): Promise<Response> {
  if (!linqInboundConfigured()) {
    deps.log.warn(
      { missing: linqMissingInboundEnv() },
      'linq inbound: not configured — the door is dark',
    );
    return json({ error: 'linq_not_configured' }, 503);
  }

  const rawBody = await req.text();
  const secret = linqWebhookSecret();
  // Configured above, so the secret is present. Read again so the verifier never
  // sees a value this function invented.
  if (!secret) {
    deps.log.warn({ missing: ['LINQ_WEBHOOK_SECRET'] }, 'linq inbound: not configured');
    return json({ error: 'linq_not_configured' }, 503);
  }

  const valid = verifyLinqWebhookSignature({
    secret,
    rawBody,
    webhookId: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
    now: deps.now?.(),
  });
  if (!valid) return json({ error: 'invalid_signature' }, 403);

  const version = new URL(req.url).searchParams.get('version');
  if (version !== LINQ_WEBHOOK_VERSION) {
    deps.log.error(
      { version },
      'linq inbound: subscription URL is not pinned to webhook version 2026-02-03',
    );
    await deps.countOutcome('malformed');
    return json({ error: 'unsupported_webhook_version' }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    deps.log.error('linq inbound: authentic POST whose body is not JSON');
    await deps.countOutcome('malformed');
    return json({ outcome: 'malformed' });
  }

  const parsed = parseLinqWebhook(payload, deps.now?.() ?? new Date());
  if (parsed.kind === 'receipt') {
    const { receipt } = parsed;
    const apply = await applyDeliveryStatus(deps.database, {
      providerMessageId: receipt.messageId,
      rawStatus: receipt.rawStatus,
      errorCode: receipt.errorCode,
    });
    deps.log.info(
      { event: receipt.event, apply, providerMessageId: receipt.messageId },
      'linq receipt',
    );
    if (apply === 'unknown_message') {
      deps.log.warn(
        { event: receipt.event, providerMessageId: receipt.messageId },
        'linq receipt: no ledger row for this provider id',
      );
    }
    await deps.countOutcome('receipt');
    return json({ outcome: 'receipt', apply });
  }
  if (parsed.kind === 'ignored') {
    const outcome = IGNORE_OUTCOME[parsed.reason];
    deps.log.info({ outcome }, 'linq inbound: ignored');
    await deps.countOutcome(ignoreCount(parsed.reason));
    return json({ outcome });
  }
  if (parsed.kind === 'signal') return handleLinqSignal(deps, parsed.signal);
  if (parsed.kind === 'location') return handleLinqLocation(deps, parsed.location);
  if (parsed.kind === 'group') return handleLinqGroup(deps, parsed.message);

  const message = parsed.message;
  // Read receipt first, overlapping the turn. Linq's mark-as-read is what puts
  // "Read" under the parent's bubble. It must not be able to fail the reply:
  // the promise is awaited below, and every result but `accepted` is a log line.
  const markRead = deps.markRead ?? markLinqChatRead;
  const readPromise = markRead({ chatId: message.chatId });
  let outcome: InboundRouteOutcome;
  let answered: Record<string, unknown> | null = null;
  try {
    const steered = await steerNotedCoparentOneToOne(deps.database, message, coparentPorts(deps));
    if (steered.type === 'done') {
      outcome = steered.count;
      answered = steered.body;
    } else {
      const trigger = matchLinqGroupTrigger(message.text);
      if (trigger) {
        const mapped = await mapGroupHandlesToFamily(deps.database, {
          sender: message.senderHandle,
          others: [],
        });
        if (mapped.status === 'same_family') {
          const nudge = await answerGroupTriggerInOneToOne(deps, message, mapped, trigger);
          outcome = nudge.count;
          answered = nudge.body;
        } else {
          outcome = await routeOneToOne(deps, message);
        }
      } else {
        outcome = await routeOneToOne(deps, message);
      }
    }
  } finally {
    try {
      const read = await readPromise;
      if (read.status !== 'accepted') {
        deps.log.warn(
          {
            outcome: read.status,
            ...(read.status === 'refused' ? { code: read.code, httpStatus: read.httpStatus } : {}),
            ...(read.status === 'unreachable' ? { reason: read.reason } : {}),
          },
          'linq inbound: mark read did not land',
        );
      }
    } catch (err) {
      deps.log.warn(
        { outcome: 'unreachable', reason: err instanceof Error ? err.name : 'unknown' },
        'linq inbound: mark read did not land',
      );
    }
  }
  if (answered) {
    deps.log.info(
      { outcome: answered.outcome, providerMessageId: message.messageId },
      'linq inbound: group trigger in the 1:1',
    );
    await deps.countOutcome(outcome);
    return json(answered);
  }
  deps.log.info({ outcome, providerMessageId: message.messageId }, 'linq inbound: routed');
  await deps.countOutcome(outcome);
  return json({ outcome });
}

async function handleLinqLocation(
  deps: Parameters<typeof handleLinqInboundRequest>[1],
  location: LinqLocationSignal,
): Promise<Response> {
  if (location.event === 'location.sharing.stopped') {
    await deps.countOutcome('location_stopped');
    return json({ outcome: 'location_stopped' });
  }
  if (!firstTouchLadderEnabled()) {
    deps.log.info(
      { outcome: 'location_ignored' },
      'linq inbound: location share while ladder is off',
    );
    await deps.countOutcome('location_ignored');
    return json({ outcome: 'location_ignored' });
  }
  const phone = normalizePhoneE164(location.sharedBy);
  if (!phone) {
    deps.log.info(
      { outcome: 'location_handle_not_phone' },
      'linq inbound: location share is not a phone handle',
    );
    await deps.countOutcome('location_handle_not_phone');
    return json({ outcome: 'location_handle_not_phone' });
  }
  const session = await loadOpenSession(deps.database, phone);
  if (!session || session.state !== 'awaiting_place') {
    deps.log.info(
      { outcome: 'location_not_waiting' },
      'linq inbound: location share is not a place ask',
    );
    await deps.countOutcome('location_not_waiting');
    return json({ outcome: 'location_not_waiting' });
  }
  const read = deps.readSharedLocality ?? readSharedLocality;
  const shared = await read(location.chatId);
  if (shared.status !== 'locality') {
    deps.log.info(
      {
        outcome: 'location_unread',
        read: shared.status,
        ...(shared.status === 'refused' ? { code: shared.code } : {}),
      },
      'linq inbound: location share had no locality',
    );
    await deps.countOutcome('location_unread');
    return json({ outcome: 'location_unread' });
  }
  const providerId =
    location.eventId ?? `location:${location.chatId}:${location.beganAt ?? 'open'}`;
  const outcome = await routeInboundText(
    deps,
    {
      from: phone,
      transport: 'imessage',
      body: shared.locality,
      providerId,
      receivedAt: deps.now?.() ?? new Date(),
      chatId: location.chatId,
      isGroup: false,
    },
    0,
  );
  deps.log.info({ outcome }, 'linq inbound: location share continued the ladder');
  await deps.countOutcome(outcome);
  return json({ outcome });
}

async function routeOneToOne(
  deps: LinqDoorDeps,
  message: LinqInboundText,
): Promise<InboundRouteOutcome> {
  // A forwarded link is queued for extraction. The reply the parent was already
  // going to get does not change, and a failure here is named rather than fatal.
  if (socialWatchlistEnabled()) {
    try {
      const forward = await considerSocialForward(deps.database, {
        text: message.text,
        senderHandle: message.senderHandle,
      });
      if (forward.status === 'queued') {
        deps.log.info({ outcome: 'social_forward_queued' }, 'linq inbound: social forward queued');
      }
    } catch (err) {
      deps.log.error(
        { err, outcome: 'social_forward_failed' },
        'linq inbound: social forward failed',
      );
    }
  }
  return routeInboundText(
    deps,
    {
      from: message.senderHandle,
      transport: 'imessage',
      body: message.text,
      providerId: message.messageId,
      receivedAt: message.receivedAt,
      chatId: message.chatId,
      providerAnsweredKeyword: null,
    },
    message.mediaCount,
  );
}

type LinqDoorDeps = Parameters<typeof handleLinqInboundRequest>[1];

function coparentPorts(deps: LinqDoorDeps): GroupCoparentPorts {
  return {
    now: deps.now?.() ?? new Date(),
    recordInbound: (message, owner) => recordHandledInbound(deps, message, owner),
    voice: deps.groupVoice,
    ...('requestIntentReader' in deps ? { intentReader: deps.requestIntentReader } : {}),
  };
}

/**
 * A group is the household year only once Hale has claimed it. The trigger
 * from an enrolled parent of one family is that claim. Anyone else is held,
 * and a STOP from them sends nothing. A STOP from a parent still routes, so
 * the opt-out does not wait on the claim.
 */
async function handleLinqGroup(deps: LinqDoorDeps, message: LinqInboundText): Promise<Response> {
  const coparent = await considerGroupCoparent(deps.database, message, coparentPorts(deps));
  if (coparent.type === 'claim') {
    return claimGroupFromTrigger(deps, message, coparent, coparent.language);
  }
  if (coparent.type === 'route_member') {
    return routeClaimedGroup(deps, message);
  }
  if (coparent.type === 'done') {
    deps.log.info({ outcome: coparent.outcome }, 'linq inbound: group coparent');
    await deps.countOutcome(coparent.count);
    return json(coparent.body);
  }

  const optOut = matchKeyword(message.text);
  if (optOut?.keyword !== 'stop') {
    const shared = await takeMultiFamilyTurn(deps.database, {
      chatId: message.chatId,
      senderHandle: message.senderHandle,
      text: message.text,
      providerMessageId: message.messageId,
      receivedAt: message.receivedAt,
      now: deps.now?.() ?? new Date(),
      send: deps.sendGroupText,
    });
    if (shared.handled) {
      deps.log.info({ outcome: shared.outcome }, 'linq inbound: multi-family group');
      await deps.countOutcome(shared.count);
      return json({
        outcome: shared.outcome,
        ...(shared.notice ? { notice: shared.notice } : {}),
      });
    }
  }

  if (await shouldHoldGroupStranger(deps.database, message)) {
    const keyword = matchKeyword(message.text);
    if (keyword?.keyword === 'stop') {
      deps.log.info({ outcome: 'group_opt_out' }, 'linq inbound: group opt-out, no reply');
      await deps.countOutcome('ignored');
      return json({ outcome: 'group_opt_out' });
    }
    const held = await holdTrueStrangerOnce(deps.database, {
      chatId: message.chatId,
      senderHandle: message.senderHandle,
      now: deps.now?.() ?? new Date(),
      send: deps.sendGroupText,
      voice: deps.groupVoice,
    });
    if (held !== 'no_family') {
      deps.log.info({ outcome: 'group_unknown_sender', hold: held }, 'linq inbound: group held');
      await deps.countOutcome('ignored');
      return json({ outcome: 'group_unknown_sender', hold: held });
    }
  }

  const others = message.otherHandles.filter((handle) => handle !== message.senderHandle);
  const mapped = await mapGroupHandlesToFamily(deps.database, {
    sender: message.senderHandle,
    others,
  });
  if (mapped.status !== 'same_family') {
    const keyword = matchKeyword(message.text);
    if (keyword?.keyword === 'stop') {
      deps.log.info({ outcome: 'group_opt_out' }, 'linq inbound: group opt-out, no reply');
      await deps.countOutcome('ignored');
      return json({ outcome: 'group_opt_out' });
    }
    const hold = deps.holdGroup ?? ((input: { chatId: string }) => holdUnknownGroupSender(input));
    const held = await hold({ chatId: message.chatId });
    const outcome =
      mapped.status === 'unknown_sender' ? 'group_unknown_sender' : 'group_mixed_family';
    deps.log.info({ outcome, hold: held }, 'linq inbound: group held');
    await deps.countOutcome('ignored');
    return json({ outcome, hold: held });
  }

  const keyword = matchKeyword(message.text);
  if (keyword) return routeClaimedGroup(deps, message);

  const trigger = matchLinqGroupTrigger(message.text);
  if (trigger) return claimGroupFromTrigger(deps, message, mapped, trigger);

  const owned = await familyOwnsLinqGroupChat(deps.database, mapped.familyId, message.chatId);
  if (!owned) {
    deps.log.info(
      { outcome: 'group_unclaimed' },
      'linq inbound: group is not the household thread',
    );
    await deps.countOutcome('ignored');
    return json({ outcome: 'group_unclaimed' });
  }

  return routeClaimedGroup(deps, message);
}

async function routeClaimedGroup(deps: LinqDoorDeps, message: LinqInboundText): Promise<Response> {
  const mapped = await mapGroupHandlesToFamily(deps.database, {
    sender: message.senderHandle,
    others: [],
  });
  if (mapped.status === 'same_family') {
    if (coparentDutyAsksArmed()) {
      await shadowWhenArmed(deps.database, deps.log, {
        familyId: mapped.familyId,
        actorUserId: mapped.userId,
        source: 'text',
        text: message.text,
        tapback: null,
        choiceKind: null,
        choiceValue: null,
        subjectKey: null,
        now: deps.now?.() ?? new Date(),
      });
      try {
        await settleDutyMemory(deps.database, {
          familyId: mapped.familyId,
          actorUserId: mapped.userId,
          text: message.text,
          now: deps.now?.() ?? new Date(),
          inboundChatId: message.chatId,
          inboundMessageId: message.messageId,
          surface: 'group',
        });
      } catch (err) {
        deps.log.warn(
          { code: err instanceof Error ? err.name : 'unknown' },
          'linq inbound: duty memory was not recorded',
        );
      }
      try {
        await answerParentDutyAsk(deps.database, {
          familyId: mapped.familyId,
          actorUserId: mapped.userId,
          text: message.text,
          now: deps.now?.() ?? new Date(),
        });
      } catch (err) {
        deps.log.warn(
          { code: err instanceof Error ? err.name : 'unknown' },
          'linq inbound: duty ask was not answered',
        );
      }
    }
    try {
      await captureLogisticsText(deps.database, {
        familyId: mapped.familyId,
        parentUserId: mapped.userId,
        body: message.text,
        now: deps.now?.() ?? new Date(),
      });
    } catch (err) {
      deps.log.warn(
        { code: err instanceof Error ? err.name : 'unknown' },
        'linq inbound: logistics text was not stored',
      );
    }
  }
  const outcome = await routeInboundText(
    deps,
    {
      from: message.senderHandle,
      transport: 'imessage',
      body: message.text,
      providerId: message.messageId,
      receivedAt: message.receivedAt,
      chatId: message.chatId,
      isGroup: true,
      providerAnsweredKeyword: null,
    },
    message.mediaCount,
  );
  deps.log.info({ outcome, providerMessageId: message.messageId }, 'linq inbound: group routed');
  await deps.countOutcome(outcome);
  return json({ outcome });
}

async function claimGroupFromTrigger(
  deps: LinqDoorDeps,
  message: LinqInboundText,
  mapped: { familyId: string; userId: string },
  language: 'en' | 'fr',
): Promise<Response> {
  const recorded = await recordHandledInbound(deps, message, mapped);
  if (!recorded) {
    await deps.countOutcome('duplicate');
    return json({ outcome: 'duplicate' });
  }

  const now = deps.now?.() ?? new Date();
  const claim = await claimHouseholdLinqGroup(deps.database, {
    familyId: mapped.familyId,
    parentUserId: mapped.userId,
    chatId: message.chatId,
    now,
  });
  const accepted = claim.status === 'claimed' || claim.status === 'already_this';
  const refused =
    claim.status === 'claimed_by_other_family' || claim.status === 'already_other_chat';
  if (!accepted && !refused) {
    deps.log.info({ outcome: claim.status }, 'linq inbound: group claim did not land');
    await deps.countOutcome('ignored');
    return json({ outcome: 'group_claim_refused', claim: claim.status });
  }

  const appearing =
    accepted && linqGroupCoparentEnabled()
      ? firstSeatableHandle(message.otherHandles, message.senderHandle)
      : null;
  if (appearing) {
    const seated = await seatAppearingCoparent(deps.database, {
      familyId: mapped.familyId,
      invitedByUserId: mapped.userId,
      phoneE164: appearing,
      chatId: message.chatId,
      verbatim: message.text,
      now,
    });
    if (seated.status === 'seated') {
      // Claimed before the model is asked (welcomeSeatedCoparent), so a webhook retry
      // costs no second call, and an unwritten welcome is retried on their next message.
      const notice = await welcomeSeatedCoparent(deps.database, {
        familyId: mapped.familyId,
        userId: seated.userId,
        chatId: message.chatId,
        language,
        ports: { voice: deps.groupVoice, now, send: deps.sendGroupText },
      });
      deps.log.info(
        { outcome: 'group_claimed', claim: claim.status, notice },
        'linq inbound: group claim',
      );
      await deps.countOutcome('intake');
      return json({ outcome: 'group_claimed', claim: claim.status, notice });
    }
  }

  const notice = await deliverLinqGroupNotice(deps.database, {
    familyId: mapped.familyId,
    parentUserId: mapped.userId,
    chatId: message.chatId,
    text: accepted ? LINQ_GROUP_OPEN_TEXT : LINQ_GROUP_CLAIM_REFUSED_TEXT[language],
    templateKey: accepted ? LINQ_GROUP_CLAIMED_TEMPLATE_KEY : LINQ_GROUP_CLAIM_REFUSED_TEMPLATE_KEY,
    now,
    send: deps.sendGroupText,
  });
  const outcome = accepted ? 'group_claimed' : 'group_claim_refused';
  deps.log.info({ outcome, claim: claim.status, notice }, 'linq inbound: group claim');
  await deps.countOutcome('intake');
  return json({ outcome, claim: claim.status, notice });
}

/**
 * The trigger in the 1:1 is not a claim. Point the parent at the group they
 * have to start. An unknown sender falls through to the ordinary door.
 */
async function answerGroupTriggerInOneToOne(
  deps: LinqDoorDeps,
  message: LinqInboundText,
  mapped: { familyId: string; userId: string },
  language: 'en' | 'fr',
): Promise<{ count: InboundRouteOutcome; body: Record<string, unknown> }> {
  const recorded = await recordHandledInbound(deps, message, mapped);
  if (!recorded) return { count: 'duplicate', body: { outcome: 'duplicate' } };

  const from = linqFromE164();
  const text = from
    ? linqGroupTriggerInOneToOne(formatLinqLineForParent(from), language)
    : LINQ_GROUP_LINE_MISSING_TEXT[language];
  const notice = await deliverLinqGroupNotice(deps.database, {
    familyId: mapped.familyId,
    parentUserId: mapped.userId,
    chatId: message.chatId,
    text,
    templateKey: LINQ_GROUP_TRIGGER_1TO1_TEMPLATE_KEY,
    now: deps.now?.() ?? new Date(),
    send: deps.sendGroupText,
  });
  return { count: 'intake', body: { outcome: 'group_trigger_in_1to1', notice } };
}

/**
 * The trigger is on the ledger and is not owed to C1. `handedOffAt` is set
 * now so the unhanded reconciler does not enqueue a second reply.
 * A second delivery of the same provider id returns null.
 */
async function recordHandledInbound(
  deps: LinqDoorDeps,
  message: LinqInboundText,
  owner: { familyId: string; userId: string },
): Promise<string | null> {
  const now = deps.now?.() ?? new Date();
  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: message.messageId,
      providerChatId: message.chatId,
      status: 'delivered',
      body: message.text,
      sentAt: message.receivedAt,
      handedOffAt: now,
    })
    .onConflictDoNothing({
      target: schema.channelMessages.providerMessageId,
      where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) return null;
  await deps.database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'sms_reply_received',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

/** Reactions, typing, and participant changes are acked. A poll vote for a
 * find title is that title, routed like a parent typed it. The locked none
 * option is recorded and not routed. Handles are not logged. */
async function handleLinqSignal(deps: LinqDoorDeps, signal: LinqSignal): Promise<Response> {
  deps.log.info(
    {
      event: signal.event,
      chatId: signal.chatId,
      messageId: signal.messageId,
      reactionType: signal.reactionType,
      optionId: signal.optionId,
      isFromMe: signal.isFromMe,
    },
    'linq signal',
  );
  if (signal.isFromMe) {
    await deps.countOutcome('ignored');
    return json({ outcome: 'signal_from_me' });
  }
  if (
    signal.event === 'poll.vote.added' &&
    signal.optionId &&
    signal.senderHandle &&
    signal.chatId
  ) {
    const option = await lookupLinqPollOption(deps.database, signal.optionId);
    if (!option) {
      await deps.countOutcome('ignored');
      return json({ outcome: 'poll_option_unknown' });
    }
    const mapped = await mapGroupHandlesToFamily(deps.database, {
      sender: signal.senderHandle,
      others: [],
    });
    if (mapped.status !== 'same_family' || mapped.familyId !== option.familyId) {
      await deps.countOutcome('ignored');
      return json({ outcome: 'poll_sender_unknown' });
    }
    // Same as a 1:1 message: mark read overlaps the turn and cannot fail it.
    // A group chat no-ops at Linq; the call is still the 1:1 receipt.
    const markRead = deps.markRead ?? markLinqChatRead;
    const readPromise = markRead({ chatId: signal.chatId });
    const providerId = `poll:${signal.messageId ?? 'vote'}:${signal.optionId}:${phoneBlindIndex(signal.senderHandle)}`;
    let outcome: InboundRouteOutcome;
    try {
      if (isLogisticsPollKind(option.pollKind) && option.subjectKey) {
        const recorded = await recordHandledInbound(
          deps,
          {
            messageId: providerId,
            chatId: signal.chatId,
            senderHandle: signal.senderHandle,
            text: option.text,
            mediaCount: 0,
            receivedAt: deps.now?.() ?? new Date(),
            otherHandles: [],
          },
          { familyId: mapped.familyId, userId: mapped.userId },
        );
        if (!recorded) {
          outcome = 'duplicate';
        } else {
          if (coparentDutyAsksArmed() && option.pollKind === 'who_takes') {
            await shadowWhenArmed(deps.database, deps.log, {
              familyId: option.familyId,
              actorUserId: mapped.userId,
              source: 'poll',
              text: option.text,
              tapback: null,
              choiceKind: option.choiceKind,
              choiceValue: option.choiceValue,
              subjectKey: option.subjectKey,
              now: deps.now?.() ?? new Date(),
            });
          }
          const vote = await recordLogisticsVote(deps.database, {
            familyId: option.familyId,
            parentUserId: mapped.userId,
            subjectKey: option.subjectKey,
            pollKind: option.pollKind === 'both_free' ? 'both_free' : 'who_takes',
            choiceKind: option.choiceKind,
            choiceValue: option.choiceValue,
            optionText: option.text,
            now: deps.now?.() ?? new Date(),
          });
          outcome = vote === 'ignored' ? 'ignored' : 'poll_logistics';
        }
      } else if (isYearFindPollNone(option.text)) {
        const recorded = await recordHandledInbound(
          deps,
          {
            messageId: providerId,
            chatId: signal.chatId,
            senderHandle: signal.senderHandle,
            text: option.text,
            mediaCount: 0,
            receivedAt: deps.now?.() ?? new Date(),
            otherHandles: [],
          },
          { familyId: mapped.familyId, userId: mapped.userId },
        );
        outcome = recorded ? 'poll_none' : 'duplicate';
      } else {
        outcome = await routeInboundText(
          deps,
          {
            from: signal.senderHandle,
            transport: 'imessage',
            body: option.text,
            providerId,
            receivedAt: deps.now?.() ?? new Date(),
            chatId: signal.chatId,
            providerAnsweredKeyword: null,
          },
          0,
        );
      }
    } finally {
      try {
        const read = await readPromise;
        if (read.status !== 'accepted') {
          deps.log.warn(
            {
              outcome: read.status,
              ...(read.status === 'refused'
                ? { code: read.code, httpStatus: read.httpStatus }
                : {}),
              ...(read.status === 'unreachable' ? { reason: read.reason } : {}),
            },
            'linq inbound: mark read did not land',
          );
        }
      } catch (err) {
        deps.log.warn(
          { outcome: 'unreachable', reason: err instanceof Error ? err.name : 'unknown' },
          'linq inbound: mark read did not land',
        );
      }
    }
    await deps.countOutcome(outcome);
    return json({ outcome });
  }
  if (
    (signal.event === 'participant.added' || signal.event === 'participant.removed') &&
    signal.chatId &&
    signal.participantHandle &&
    linqGroupMembersEnabled()
  ) {
    const now = deps.now?.() ?? new Date();
    if (signal.event === 'participant.added') {
      const seated = await seatParticipantAdded(deps.database, {
        chatId: signal.chatId,
        participantHandle: signal.participantHandle,
        actorHandle: signal.actorHandle,
        isFromMe: signal.isFromMe,
        now,
        send: deps.sendGroupText,
        voice: deps.groupVoice,
      });
      await deps.countOutcome(seated.outcome === 'group_member_seated' ? 'intake' : 'ignored');
      return json({
        outcome: seated.outcome,
        ...(seated.outcome === 'group_member_seated'
          ? { notice: seated.notice, role: seated.role }
          : {}),
      });
    }
    const unseated = await unseatParticipantRemoved(deps.database, {
      chatId: signal.chatId,
      participantHandle: signal.participantHandle,
      now,
    });
    const multi = linqMultiFamilyGroupsEnabled()
      ? await unseatMultiFamilyMember(deps.database, {
          chatId: signal.chatId,
          participantHandle: signal.participantHandle,
          now,
        })
      : null;
    await deps.countOutcome('ignored');
    return json({
      outcome: multi?.outcome === 'linq_multi_family_unseated' ? multi.outcome : unseated.outcome,
    });
  }
  if (
    signal.event === 'participant.removed' &&
    signal.chatId &&
    signal.participantHandle &&
    linqMultiFamilyGroupsEnabled() &&
    !linqGroupMembersEnabled()
  ) {
    const multi = await unseatMultiFamilyMember(deps.database, {
      chatId: signal.chatId,
      participantHandle: signal.participantHandle,
      now: deps.now?.() ?? new Date(),
    });
    await deps.countOutcome('ignored');
    return json({ outcome: multi.outcome });
  }
  if (
    signal.event === 'participant.added' &&
    signal.chatId &&
    signal.participantHandle &&
    linqGroupCoparentEnabled()
  ) {
    const familyId = await familyIdForClaimedChat(deps.database, signal.chatId);
    if (familyId) {
      const now = deps.now?.() ?? new Date();
      const seated = await seatAppearingCoparent(deps.database, {
        familyId,
        invitedByUserId: null,
        phoneE164: signal.participantHandle,
        chatId: signal.chatId,
        verbatim: '',
        now,
      });
      if (seated.status === 'seated') {
        const notice = await welcomeSeatedCoparent(deps.database, {
          familyId,
          userId: seated.userId,
          chatId: signal.chatId,
          language: 'en',
          ports: { voice: deps.groupVoice, now, send: deps.sendGroupText },
        });
        await deps.countOutcome('intake');
        return json({ outcome: 'group_coparent_seated', notice });
      }
    }
  }
  if (
    coparentDutyAsksArmed() &&
    signal.senderHandle &&
    signal.chatId &&
    (signal.event === 'poll.vote.removed' || signal.event === 'reaction.added')
  ) {
    const mapped = await mapGroupHandlesToFamily(deps.database, {
      sender: signal.senderHandle,
      others: [],
    });
    if (mapped.status === 'same_family') {
      const now = deps.now?.() ?? new Date();
      if (signal.event === 'reaction.added' && signal.messageId) {
        await shadowTapbackIfDuty(deps.database, deps.log, {
          familyId: mapped.familyId,
          actorUserId: mapped.userId,
          messageId: signal.messageId,
          reactionType: signal.reactionType,
          now,
        });
      } else if (signal.event === 'poll.vote.removed' && signal.optionId) {
        const option = await lookupLinqPollOption(deps.database, signal.optionId);
        if (
          option &&
          option.familyId === mapped.familyId &&
          option.pollKind === 'who_takes' &&
          option.subjectKey
        ) {
          await shadowWhenArmed(deps.database, deps.log, {
            familyId: option.familyId,
            actorUserId: mapped.userId,
            source: 'poll_vote_removed',
            text: option.text,
            tapback: null,
            choiceKind: option.choiceKind,
            choiceValue: option.choiceValue,
            subjectKey: option.subjectKey,
            now,
          });
        }
      }
    }
  }
  await deps.countOutcome('ignored');
  return json({ outcome: signal.event });
}

async function familyIdForClaimedChat(
  database: LinqDoorDeps['database'],
  chatId: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return rows.find((row) => row.linqGroupChatId === chatId)?.id ?? null;
}

/** What the HTTP response and the log line call each decline. Finer than the
 * counter, which only has the SMS door's vocabulary. */
const IGNORE_OUTCOME = {
  malformed: 'malformed',
  unsupported_version: 'unsupported_payload_version',
  not_message_received: 'ignored_event',
  outbound: 'ignored_outbound',
} as const;

/** The counter's vocabulary is the SMS door's. Group / outbound / other events
 * are `ignored`; a body we cannot read is `malformed`. */
function ignoreCount(reason: keyof typeof IGNORE_OUTCOME): InboundRouteOutcome {
  return reason === 'malformed' || reason === 'unsupported_version' ? 'malformed' : 'ignored';
}
