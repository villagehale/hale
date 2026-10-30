import { createHash } from 'node:crypto';
import { linqVoiceMemosEnabled } from '~/lib/channel/linq/config';
import { checkLinqIMessageCapability, sendLinqVoiceMemo } from '~/lib/channel/linq/transport';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import { PREVIEW_CHAT_PREFIX, previewGroupCaptureOpen } from '~/lib/channel/preview-linq-capture';

/**
 * VIL-476 · Preview-only forced voice memo, for the fake-family proof.
 *
 * POST { to: +1437555XXXX, audioUrl: https://… } runs the real capability check for
 * that fictional handle and, only when it reads `available`, one real
 * `sendLinqVoiceMemo` into that handle's fake 1:1 chat. Both calls land in the group
 * capture table (never fetched); read them back from
 * GET /api/channels/preview/group-captured?chatId=… (the chat ids are in the answer).
 *
 * Gated like every Preview route (VERCEL_ENV=preview, capture on, no Linq keys,
 * bearer), plus PREVIEW_CAPTURE_GROUPS=on and LINQ_VOICE_MEMOS_ENABLED=true. The audio
 * URL is supplied by the proof caller; this is a test door, not a product path, so it
 * carries no audio of its own and no copy.
 */
type Env = Readonly<Record<string, string | undefined>>;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

/** A stable fake 1:1 chat id for a fictional handle. */
export function fakeOneToOneChatId(handle: string): string {
  const h = createHash('sha256').update(handle).digest('hex').slice(0, 16);
  return `${PREVIEW_CHAT_PREFIX}voice-${h}`;
}

export async function handlePreviewVoiceMemo(
  req: Request,
  deps: { env?: Env } = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;
  if (!previewGroupCaptureOpen(env)) return new Response(null, { status: 404 });
  if (!linqVoiceMemosEnabled()) return json({ error: 'voice_memos_dark' }, 409);

  let payload: { to?: unknown; audioUrl?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const to = fakeSender(payload.to);
  if (!to) return json({ error: 'sender_not_fictional' }, 400);
  if (typeof payload.audioUrl !== 'string') return json({ error: 'audio_url_missing' }, 400);

  const capability = await checkLinqIMessageCapability({ address: to });
  if (capability.status !== 'available') {
    // Design lock: unknown / unavailable is text, never bare audio.
    return json({ capability: capability.status, sent: false });
  }
  const chatId = fakeOneToOneChatId(to);
  const { providerMessageId } = await sendLinqVoiceMemo({
    chatId,
    audio: { url: payload.audioUrl },
  });
  return json({
    capability: capability.status,
    capabilityChatId: `${PREVIEW_CHAT_PREFIX}capability-check`,
    sent: true,
    chatId,
    providerMessageId,
  });
}
