import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import {
  type TwilioInboundDeps,
  type TwilioInboundOutcome,
  routeTwilioInbound,
} from '~/lib/channel/twilio/inbound';
import { applyTwilioStatus } from '~/lib/channel/twilio/status';
import {
  linqFromE164,
  linqInboundConfigured,
  linqMissingInboundEnv,
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
  steerNotedCoparentOneToOne,
} from './group-coparent';
import { type LinqInboundText, type LinqSignal, parseLinqWebhook } from './payload';
import { lookupLinqPollOption } from './poll';
import { LINQ_WEBHOOK_VERSION, verifyLinqWebhookSignature } from './signature';
import { type LinqEffectResult, markLinqChatRead } from './transport';

/**
 * VIL-335 — POST /api/channels/linq/inbound.
 *
 * The same conversation the SMS door already runs. Signature first, then the
 * pinned payload version, then `routeTwilioInbound`: normalize the sender
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
 * Linq group co-parent seating is on unless `LINQ_GROUP_COPARENT=off`. A number
 * the parent already noted is seated on that same family when they speak in
 * the claimed group. SMS does not read the flag.
 * Reactions, typing, and participant events answer 200. A poll vote becomes
 * the option's text and enters the same router a typed reply would.
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
  deps: TwilioInboundDeps & {
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
    const apply = await applyTwilioStatus(deps.database, {
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
  if (parsed.kind === 'group') return handleLinqGroup(deps, parsed.message);

  const message = parsed.message;
  // Read receipt first, overlapping the turn. Linq's mark-as-read is what puts
  // "Read" under the parent's bubble. It must not be able to fail the reply:
  // the promise is awaited below, and every result but `accepted` is a log line.
  const markRead = deps.markRead ?? markLinqChatRead;
  const readPromise = markRead({ chatId: message.chatId });
  let outcome: TwilioInboundOutcome;
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

async function routeOneToOne(
  deps: LinqDoorDeps,
  message: LinqInboundText,
): Promise<TwilioInboundOutcome> {
  return routeTwilioInbound(
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
  const outcome = await routeTwilioInbound(
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
): Promise<{ count: TwilioInboundOutcome; body: Record<string, unknown> }> {
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

/** Reactions, typing, and participant changes are acked. A poll vote is the
 * option text, routed like a parent typed it. Handles are not logged. */
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
    const outcome = await routeTwilioInbound(
      deps,
      {
        from: signal.senderHandle,
        transport: 'imessage',
        body: option.text,
        providerId: `poll:${signal.messageId ?? 'vote'}:${signal.optionId}`,
        receivedAt: deps.now?.() ?? new Date(),
        chatId: signal.chatId,
        providerAnsweredKeyword: null,
      },
      0,
    );
    await deps.countOutcome(outcome);
    return json({ outcome });
  }
  await deps.countOutcome('ignored');
  return json({ outcome: signal.event });
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
function ignoreCount(reason: keyof typeof IGNORE_OUTCOME): TwilioInboundOutcome {
  return reason === 'malformed' || reason === 'unsupported_version' ? 'malformed' : 'ignored';
}
