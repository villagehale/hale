import {
  type TwilioInboundDeps,
  type TwilioInboundOutcome,
  routeTwilioInbound,
} from '~/lib/channel/twilio/inbound';
import { applyTwilioStatus } from '~/lib/channel/twilio/status';
import { linqInboundConfigured, linqMissingInboundEnv, linqWebhookSecret } from './config';
import { parseLinqWebhook } from './payload';
import { LINQ_WEBHOOK_VERSION, verifyLinqWebhookSignature } from './signature';

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
 * Group chats, outbound echoes, and events this door does not act on answer
 * 200 with a named outcome. A 4xx/5xx would make Linq retry work this door is
 * declining on purpose.
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
  deps: TwilioInboundDeps,
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

  const message = parsed.message;
  const outcome = await routeTwilioInbound(
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
  deps.log.info({ outcome, providerMessageId: message.messageId }, 'linq inbound: routed');
  await deps.countOutcome(outcome);
  return json({ outcome });
}

/** What the HTTP response and the log line call each decline. Finer than the
 * counter, which only has the SMS door's vocabulary. */
const IGNORE_OUTCOME = {
  malformed: 'malformed',
  unsupported_version: 'unsupported_payload_version',
  not_message_received: 'ignored_event',
  outbound: 'ignored_outbound',
  group: 'group_ignored',
} as const;

/** The counter's vocabulary is the SMS door's. Group / outbound / other events
 * are `ignored`; a body we cannot read is `malformed`. */
function ignoreCount(reason: keyof typeof IGNORE_OUTCOME): TwilioInboundOutcome {
  return reason === 'malformed' || reason === 'unsupported_version' ? 'malformed' : 'ignored';
}
