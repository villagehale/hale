import { createHash } from 'node:crypto';
import {
  type AppClipPayDecider,
  type AppClipPayOutcome,
  type AppClipPayPrior,
  deliverAppClipPay,
  deliverAppClipPayFallback,
  sharedAppClipPayDecider,
} from '~/lib/channel/linq/app-clip-pay';
import { SANDBOX_PAYMENT_CHAT_ID } from '~/lib/channel/linq/app-clip-sandbox';
import { linqAppClipPayEnabled } from '~/lib/channel/linq/config';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import { PREVIEW_CHAT_PREFIX, previewGroupCaptureOpen } from '~/lib/channel/preview-linq-capture';

/**
 * VIL-481 · Preview-only Apple Pay App Clip proof, for a fake family.
 *
 * POST { to: +1437555XXXX, parentText, planTier?, childCount?, coparent?, prior?, failedCode? }
 * runs the real decider (Hale's AI). A checkout line sends one `app_clip` part.
 * `failedCode: 4005` does not also send the card: a fresh model line goes out
 * with the link, or nothing is sent. Nothing here is copy.
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
      status: 'link',
      lineProviderMessageId: outcome.lineProviderMessageId,
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

  let payload: {
    to?: unknown;
    parentText?: unknown;
    planTier?: unknown;
    childCount?: unknown;
    coparent?: unknown;
    prior?: unknown;
    failedCode?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const to = fakeSender(payload.to);
  if (!to) return json({ error: 'sender_not_fictional' }, 400);
  if (typeof payload.parentText !== 'string') return json({ error: 'parent_text_missing' }, 400);
  const planTier: 'free' | 'plus' | 'family' =
    payload.planTier === 'plus' || payload.planTier === 'family' ? payload.planTier : 'free';
  const prior: AppClipPayPrior | null =
    payload.prior === 'no' || payload.prior === 'no_tap' ? payload.prior : null;
  const childCount =
    typeof payload.childCount === 'number' &&
    Number.isInteger(payload.childCount) &&
    payload.childCount >= 0
      ? payload.childCount
      : null;

  const chatId = fakeAppClipChatId(to);
  const read = {
    audience: 'direct' as const,
    planTier,
    parentText: payload.parentText,
    childCount,
    coparent: payload.coparent === true ? true : payload.coparent === false ? false : null,
    prior,
  };
  const decider = deps.decider ?? sharedAppClipPayDecider();
  const outcome =
    payload.failedCode === 4005
      ? await deliverAppClipPayFallback({ channel: 'imessage', chatId, read, decider })
      : await deliverAppClipPay({ channel: 'imessage', chatId, read, decider });
  return json(previewAppClipBody(chatId, outcome));
}
