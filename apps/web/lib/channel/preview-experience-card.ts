import { createHash } from 'node:crypto';
import { sendLinqAppCard } from '~/lib/channel/linq/app-card';
import { linqExperiencesEnabled } from '~/lib/channel/linq/config';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import { PREVIEW_CHAT_PREFIX, previewGroupCaptureOpen } from '~/lib/channel/preview-linq-capture';

/**
 * VIL-480 · Preview-only forced experience card, for the fake-family proof.
 *
 * POST { to: +1437555XXXX, url: https://…, fallbackText?: string, asGroup?: boolean }
 * runs the real `sendLinqAppCard` into that fictional handle's fake 1:1 chat.
 * `asGroup: true` forces the documented group fallback (one recipient per experience),
 * so the same route proves the link-preview fallback. Calls land in the group capture
 * table; read back via GET /api/channels/preview/group-captured?chatId=….
 *
 * Gated like every Preview route (VERCEL_ENV=preview, capture on, no Linq keys,
 * bearer), plus PREVIEW_CAPTURE_GROUPS=on and LINQ_EXPERIENCES_ENABLED=true. Test door,
 * not a product path: it carries no copy — the caller supplies url/title.
 */
type Env = Readonly<Record<string, string | undefined>>;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export function fakeExperienceChatId(handle: string): string {
  const h = createHash('sha256').update(handle).digest('hex').slice(0, 16);
  return `${PREVIEW_CHAT_PREFIX}experience-${h}`;
}

export async function handlePreviewExperienceCard(
  req: Request,
  deps: { env?: Env } = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;
  if (!previewGroupCaptureOpen(env)) return new Response(null, { status: 404 });
  if (!linqExperiencesEnabled()) return json({ error: 'experiences_dark' }, 409);

  let payload: { to?: unknown; url?: unknown; fallbackText?: unknown; asGroup?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const to = fakeSender(payload.to);
  if (!to) return json({ error: 'sender_not_fictional' }, 400);
  if (typeof payload.url !== 'string') return json({ error: 'url_missing' }, 400);
  const fallbackText = typeof payload.fallbackText === 'string' ? payload.fallbackText : undefined;

  const chatId = fakeExperienceChatId(to);
  const outcome = await sendLinqAppCard({
    channel: 'imessage',
    chatId,
    card: { url: payload.url, fallbackText },
    recipientAddress: to,
    isGroup: payload.asGroup === true,
  });
  return json({ chatId, outcome });
}
