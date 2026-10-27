import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { type InboundMediaPart, httpsMediaUrl } from '~/lib/channel/inbound-media';
import { type InboundRouteDeps, routeInboundText } from '~/lib/channel/inbound-route';
import { readCapturedSends } from '~/lib/channel/preview-capture-store';
import { previewCaptureRequested } from '~/lib/channel/preview-capture-transport';
import { isSyntheticProbeNumber, normalizePhoneE164 } from '~/lib/channels/phone';

/**
 * VIL-466 · Preview-only fake inbound door for fake-family proof runs.
 *
 * A fake family "texts" Hale by POSTing here, and the text runs the same
 * `routeInboundText` the Linq door runs: intake, provision (source code
 * included), and the conversation router. Replies leave through the capture
 * transport and are read back from GET, word for word. No Linq, no phone.
 *
 * Gated exactly like the capture transport, plus its own secret:
 *   - VERCEL_ENV is exactly `preview` (never production, never local);
 *   - PREVIEW_CAPTURE_TRANSPORT is exactly `on`, so every reply is captured;
 *   - no LINQ_API_KEY, LINQ_FROM_E164 or LINQ_WEBHOOK_SECRET is set, so this
 *     door can never sit beside a real phone door;
 *   - PREVIEW_FAKE_INBOUND_SECRET is set and the request carries it as a bearer.
 * The sender must be in the fictional +1 437-555 probe range, so no real
 * family can be created or reached through it.
 *
 * Outside Preview every route answers a plain, empty 404, so a production deploy
 * gives no sign the door exists. On Preview a refusal is a 404 with a reason code,
 * never a line a parent would read.
 */

type Env = Readonly<Record<string, string | undefined>>;

export type FakeInboundRefusal = 'not_preview' | 'capture_off' | 'linq_configured' | 'secret_unset';

export function previewFakeInboundRefusal(env: Env = process.env): FakeInboundRefusal | null {
  if (env.VERCEL_ENV !== 'preview') return 'not_preview';
  if (!previewCaptureRequested(env)) return 'capture_off';
  const linqSet = (name: string) => (env[name] ?? '').trim().length > 0;
  if (linqSet('LINQ_API_KEY') || linqSet('LINQ_FROM_E164') || linqSet('LINQ_WEBHOOK_SECRET')) {
    return 'linq_configured';
  }
  if (!(env.PREVIEW_FAKE_INBOUND_SECRET ?? '').trim()) return 'secret_unset';
  return null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function authorized(req: Request, env: Env): boolean {
  const secret = (env.PREVIEW_FAKE_INBOUND_SECRET ?? '').trim();
  const header = req.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret || !given) return false;
  return timingSafeEqual(digest(secret), digest(given));
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

export function fakeSender(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const phone = normalizePhoneE164(raw);
  return phone && isSyntheticProbeNumber(phone) ? phone : null;
}

const MAX_MEDIA = 8;

function readMedia(raw: unknown): InboundMediaPart[] | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MEDIA) return 'invalid';
  const parts: InboundMediaPart[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'invalid';
    const { url, mime } = item as { url?: unknown; mime?: unknown };
    const safe = typeof url === 'string' ? httpsMediaUrl(url) : null;
    if (!safe) return 'invalid';
    const m = typeof mime === 'string' ? mime : null;
    const kind = m?.startsWith('video/') ? 'video' : 'image';
    parts.push({ kind, url: safe, mime: m });
  }
  return parts;
}

interface Gate {
  env?: Env;
}

/** The same empty 404 an unknown path earns: no body, no reason, no JSON type. */
function plainNotFound(): Response {
  return new Response(null, { status: 404 });
}

/** The four gates and the bearer, shared by every Preview-only route (VIL-466). */
export function previewRouteGate(req: Request, env: Env): Response | null {
  const refusal = previewFakeInboundRefusal(env);
  if (refusal === 'not_preview') return plainNotFound();
  if (refusal) return json({ error: 'not_found', reason: refusal }, 404);
  if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
  return null;
}

/**
 * POST { from, text, media?: [{ url, mime }] }. `text` may be empty when a photo
 * is attached. Answers with the router's outcome and the provider id it used.
 */
export async function handlePreviewFakeInbound(
  req: Request,
  deps: InboundRouteDeps & Gate,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;

  let payload: { from?: unknown; text?: unknown; media?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const from = fakeSender(payload.from);
  if (!from) return json({ error: 'sender_not_fictional' }, 400);
  const text = typeof payload.text === 'string' ? payload.text : '';
  const media = readMedia(payload.media);
  if (media === 'invalid') return json({ error: 'media_invalid' }, 400);
  if (!text.trim() && !media) return json({ error: 'empty' }, 400);

  const providerId = `preview-inbound-${randomUUID()}`;
  const outcome = await routeInboundText(deps, {
    from,
    transport: 'sms',
    body: text,
    providerId,
    receivedAt: deps.now?.() ?? new Date(),
    ...(media ? { media } : {}),
  });
  deps.log.info({ outcome, providerId }, 'preview fake inbound: routed');
  await deps.countOutcome(outcome);
  return json({ outcome, providerId });
}

/** GET ?to=+1437555XXXX — every captured reply to that fictional number, oldest first. */
export async function handlePreviewCapturedRead(
  req: Request,
  deps: Pick<InboundRouteDeps, 'database'> & Gate,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = previewRouteGate(req, env);
  if (shut) return shut;
  const to = fakeSender(new URL(req.url).searchParams.get('to'));
  if (!to) return json({ error: 'sender_not_fictional' }, 400);
  const sends = await readCapturedSends(deps.database, to);
  return json({ to, sends });
}
