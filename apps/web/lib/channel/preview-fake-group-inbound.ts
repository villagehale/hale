import { randomUUID } from 'node:crypto';
import type { Database } from '@hale/db';
import { handleLinqGroupMessage } from '~/lib/channel/linq/inbound';
import { parseLinqWebhook } from '~/lib/channel/linq/payload';
import { LINQ_WEBHOOK_VERSION } from '~/lib/channel/linq/signature';
import { fakeSender, previewRouteGate } from '~/lib/channel/preview-fake-inbound';
import {
  type GroupCaptureSink,
  PREVIEW_CHAT_PREFIX,
  countUncapturedGroupLedgerRows,
  databaseGroupCaptureSink,
  isFakeChatId,
  previewGroupCaptureOpen,
  readCapturedLinqCalls,
} from '~/lib/channel/preview-linq-capture';

/**
 * VIL-466 groups · Preview-only fake group inbound door.
 *
 * POST { chatId?, from, participants: [+1437555…, …], text } is one parent's
 * message in a fake household group. It is shaped as Linq's `message.received`
 * webhook, parsed by the same `parseLinqWebhook`, and run through the same group
 * handler the signed Linq door runs (roster, STOP, turn reader, coach). Every
 * group message, tapback, poll and chat update Hale makes in reply is captured by
 * preview-linq-capture.ts and read back with GET ?chatId=.
 *
 * Gated like #924's door (Preview, capture on, no Linq key/line/secret, bearer)
 * plus PREVIEW_CAPTURE_GROUPS=on. Off, the route is the same empty 404 (no reason).
 * Outside Preview it is the same empty 404.
 */
type Env = Readonly<Record<string, string | undefined>>;
type GroupDoorDeps = Parameters<typeof handleLinqGroupMessage>[0] & {
  env?: Env;
  groupSink?: GroupCaptureSink;
};

const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 12;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function gate(req: Request, env: Env): Response | null {
  const shut = previewRouteGate(req, env);
  if (shut) return shut;
  if (!previewGroupCaptureOpen(env)) {
    return new Response(null, { status: 404 });
  }
  return null;
}

function readParticipants(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < MIN_PARTICIPANTS || raw.length > MAX_PARTICIPANTS) {
    return null;
  }
  const out = new Set<string>();
  for (const item of raw) {
    const phone = fakeSender(item);
    if (!phone) return null;
    out.add(phone);
  }
  return out.size >= MIN_PARTICIPANTS ? [...out] : null;
}

export async function handlePreviewFakeGroupInbound(
  req: Request,
  deps: GroupDoorDeps,
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = gate(req, env);
  if (shut) return shut;

  let payload: { chatId?: unknown; from?: unknown; participants?: unknown; text?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: 'malformed' }, 400);
  }
  const participants = readParticipants(payload.participants);
  if (!participants) return json({ error: 'participants_not_fictional' }, 400);
  const from = fakeSender(payload.from);
  if (!from || !participants.includes(from)) return json({ error: 'sender_not_participant' }, 400);
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) return json({ error: 'empty' }, 400);
  if (payload.chatId !== undefined && !isFakeChatId(payload.chatId)) {
    return json({ error: 'chat_not_fake' }, 400);
  }
  const chatId = isFakeChatId(payload.chatId)
    ? payload.chatId
    : `${PREVIEW_CHAT_PREFIX}${randomUUID()}`;

  const now = deps.now?.() ?? new Date();
  const messageId = `preview-inbound-${randomUUID()}`;
  const sink = deps.groupSink ?? databaseGroupCaptureSink(deps.database);
  await sink.record({
    chatId,
    kind: 'roster',
    method: 'POST',
    path: '/preview/group-inbound',
    body: { messageId, from, text },
    handles: participants,
    providerMessageId: null,
  });

  const webhook = {
    webhook_version: LINQ_WEBHOOK_VERSION,
    event_type: 'message.received',
    data: {
      id: messageId,
      direction: 'inbound',
      sent_at: now.toISOString(),
      sender_handle: { handle: from, is_me: false },
      chat: {
        id: chatId,
        is_group: true,
        handles: participants.map((handle) => ({ handle, is_me: false })),
      },
      parts: [{ type: 'text', value: text }],
    },
  };
  const parsed = parseLinqWebhook(webhook, now);
  if (parsed.kind !== 'group') return json({ error: 'not_group', kind: parsed.kind }, 500);
  const res = await handleLinqGroupMessage(deps, parsed.message);
  const routed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  deps.log.info({ chatId, messageId }, 'preview fake group inbound: routed');
  return json({ chatId, messageId, routed }, res.status);
}

/** GET ?chatId=preview-chat-… — every captured partner call for that chat, oldest first. */
export async function handlePreviewGroupCapturedRead(
  req: Request,
  deps: { database: Database; env?: Env },
): Promise<Response> {
  const env = deps.env ?? process.env;
  const shut = gate(req, env);
  if (shut) return shut;
  const chatId = new URL(req.url).searchParams.get('chatId');
  if (!isFakeChatId(chatId)) return json({ error: 'chat_not_fake' }, 400);
  const calls = await readCapturedLinqCalls(deps.database, chatId);
  const uncapturedLedgered = await countUncapturedGroupLedgerRows(deps.database);
  const messages = calls.filter((c) => c.kind === 'message' || c.kind === 'chat_create');
  const reactions = calls.filter((c) => c.kind === 'reaction');
  return json({
    chatId,
    count: calls.length,
    messages: messages.length,
    reactions: reactions.length,
    uncapturedLedgered,
    calls,
  });
}
