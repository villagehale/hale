import { matchKeyword } from '~/lib/channel/intake/keywords';
import {
  type TwilioInboundDeps,
  type TwilioInboundOutcome,
  routeTwilioInbound,
} from '~/lib/channel/twilio/inbound';
import { applyTwilioStatus } from '~/lib/channel/twilio/status';
import { linqInboundConfigured, linqMissingInboundEnv, linqWebhookSecret } from './config';
import { holdUnknownGroupSender, mapGroupHandlesToFamily, rememberLinqGroupChat } from './group';
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
 * A group chat from an enrolled parent of one household continues that
 * family's year in the group. An unknown number is held and not enrolled.
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
  try {
    outcome = await routeTwilioInbound(
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
  deps.log.info({ outcome, providerMessageId: message.messageId }, 'linq inbound: routed');
  await deps.countOutcome(outcome);
  return json({ outcome });
}

type LinqDoorDeps = Parameters<typeof handleLinqInboundRequest>[1];

/** A group from a parent already on this household continues their year in
 * that chat. Anyone else is held, and a STOP from them sends nothing. */
async function handleLinqGroup(deps: LinqDoorDeps, message: LinqInboundText): Promise<Response> {
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

  await rememberLinqGroupChat(deps.database, {
    familyId: mapped.familyId,
    chatId: message.chatId,
    now: deps.now?.() ?? new Date(),
  });
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
