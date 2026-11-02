import { createHash } from 'node:crypto';
import {
  type AppClipPayDecider,
  type AppClipPayOutcome,
  deliverAppClipPay,
  sharedAppClipPayDecider,
} from '~/lib/channel/linq/app-clip-pay';
import { SANDBOX_PAYMENT_CHAT_ID } from '~/lib/channel/linq/app-clip-sandbox';
import { linqAppClipPayEnabled } from '~/lib/channel/linq/config';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import { PREVIEW_CHAT_PREFIX, previewGroupCaptureOpen } from '~/lib/channel/preview-linq-capture';

/**
 * VIL-481 · Preview-only Apple Pay App Clip proof, for a fake family.
 *
 * POST { to: +1437555XXXX, parentText, planTier?, failedCode? }
 * runs the real decider (Hale's AI) and, only when it writes a checkout line,
 * the real sandbox payment request plus one `app_clip` part into that
 * fictional handle's fake 1:1 chat. `failedCode: 4005` also sends the link
 * fallback. Nothing here is copy: a model that does not write sends nothing.
 *
 * Gated like every Preview route, plus PREVIEW_CAPTURE_GROUPS=on and
 * LINQ_APP_CLIP_PAY_ENABLED=true. No Linq key, so the call is captured and
 * never charged.
 */
type Env = Readonly<Record<string, string | undefined>>;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export function fakeAppClipChatId(handle: string): string {
  const h = createHash('sha256').update(handle).digest('hex').slice(0, 16);
  return `${PREVIEW_CHAT_PREFIX}app-clip-${h}`;
}

/** Parent-facing fields stay out of the HTTP body. The capture table holds the wire. */
export function previewAppClipBody(
  chatId: string,
  outcome: AppClipPayOutcome,
): Record<string, unknown> {
  if (outcome.status === 'not_sent') {
    return { chatId, outcome: { status: 'not_sent', reason: outcome.reason } };
  }
  if (outcome.status === 'card') {
    return {
      chatId,
      paymentCaptureChatId: SANDBOX_PAYMENT_CHAT_ID,
      outcome: {
        status: 'card',
        providerMessageId: outcome.providerMessageId,
        ledger: outcome.ledger,
      },
    };
  }
  return {
    chatId,
    paymentCaptureChatId: SANDBOX_PAYMENT_CHAT_ID,
    outcome: {
      status: 'fallback',
      cardProviderMessageId: outcome.cardProviderMessageId,
      linkProviderMessageId: outcome.linkProviderMessageId,
      ledger: outcome.ledger,
    },
  };
}

export async function handlePreviewAppClipPay(
  req: Request,
  deps: { env?: Env; decider?: AppClipPayDecider } = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;
  if (!previewGroupCaptureOpen(env)) return new Response(null, { status: 404 });
  if (!linqAppClipPayEnabled()) return json({ error: 'app_clip_pay_dark' }, 409);

  let payload: { to?: unknown; parentText?: unknown; planTier?: unknown; failedCode?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const to = fakeSender(payload.to);
  if (!to) return json({ error: 'sender_not_fictional' }, 400);
  if (typeof payload.parentText !== 'string') return json({ error: 'parent_text_missing' }, 400);
  const planTier =
    payload.planTier === 'plus' || payload.planTier === 'family' || payload.planTier === 'free'
      ? payload.planTier
      : 'free';

  const chatId = fakeAppClipChatId(to);
  const outcome = await deliverAppClipPay({
    channel: 'imessage',
    chatId,
    read: { audience: 'direct', planTier, parentText: payload.parentText },
    decider: deps.decider ?? sharedAppClipPayDecider(),
    unreachable: payload.failedCode === 4005,
  });
  return json(previewAppClipBody(chatId, outcome));
}
