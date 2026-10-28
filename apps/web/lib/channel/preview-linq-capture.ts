import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, isNotNull, like, notExists, sql } from 'drizzle-orm';
import { linqApiKey, linqFromE164 } from '~/lib/channel/linq/config';
import { previewCaptureRequested } from '~/lib/channel/preview-capture-transport';
import { isSyntheticProbeNumber, normalizePhoneE164 } from '~/lib/channels/phone';

/**
 * VIL-466 groups · The capture door for every Linq partner call a fake group makes.
 *
 * #924's capture transport owns 1:1 texts. A group message, tapback, poll, typing
 * indicator, read receipt or chat update leaves through `linqRequest` instead, which
 * a capture run used to refuse outright. With this gate open, `linqRequest` hands
 * the call here: it is recorded in `preview_captured_linq_calls`, answered with a
 * synthetic Linq-shaped 2xx so the caller ledgers and carries on, and never fetched.
 *
 * Open only when ALL hold:
 *   - VERCEL_ENV is exactly `preview`;
 *   - PREVIEW_CAPTURE_TRANSPORT is exactly `on` (#924) and PREVIEW_CAPTURE_GROUPS
 *     is exactly `on` (this door);
 *   - no LINQ_API_KEY or LINQ_FROM_E164 is set.
 * Every captured call must target a `preview-chat-…` chat or a `preview-…`
 * message, and a chat create must name only +1 437-555 handles. Anything else
 * is refused, so no real group can be captured or reached.
 */
type Env = Readonly<Record<string, string | undefined>>;

export const PREVIEW_CHAT_PREFIX = 'preview-chat-';
export const PREVIEW_GROUP_CAPTURE_ID_PREFIX = 'preview-gcapture-';
const FAKE_CHAT_ID = /^preview-chat-[a-z0-9-]{1,64}$/;

export function previewGroupCaptureOpen(env: Env = process.env): boolean {
  return (
    env.VERCEL_ENV === 'preview' &&
    previewCaptureRequested(env) &&
    env.PREVIEW_CAPTURE_GROUPS?.trim() === 'on' &&
    linqApiKey() === null &&
    linqFromE164() === null
  );
}

export function isFakeChatId(chatId: unknown): chatId is string {
  return typeof chatId === 'string' && FAKE_CHAT_ID.test(chatId);
}

export type CapturedLinqKind =
  | 'message'
  | 'reaction'
  | 'chat_create'
  | 'chat_update'
  | 'chat_read'
  | 'typing_start'
  | 'typing_stop'
  | 'mark_read'
  | 'contact_card'
  | 'poll'
  | 'participant_add'
  | 'participant_remove'
  | 'location_request'
  | 'roster';

export type CapturedLinqCall = {
  chatId: string;
  kind: CapturedLinqKind;
  method: string;
  path: string;
  body: unknown;
  handles: string[] | null;
  providerMessageId: string | null;
};

export type GroupCaptureSink = {
  record(call: CapturedLinqCall): Promise<void>;
  chatOfMessage(messageId: string): Promise<string | null>;
  handlesOf(chatId: string): Promise<string[] | null>;
};

export type CapturedLinqResponse = { status: number; payload: unknown };

export class PreviewGroupCaptureRefused extends Error {
  constructor(readonly reason: 'not_fake_chat' | 'not_fake_handle' | 'unknown_call') {
    super(`preview group capture refused: ${reason}`);
    this.name = 'PreviewGroupCaptureRefused';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fakeHandles(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const h of raw) {
    const phone = typeof h === 'string' ? normalizePhoneE164(h) : null;
    if (!phone || !isSyntheticProbeNumber(phone)) return null;
    out.push(phone);
  }
  return out;
}

let counter = 0;
function newMessageId(): string {
  counter += 1;
  return `${PREVIEW_GROUP_CAPTURE_ID_PREFIX}${Date.now()}-${counter}`;
}

const CHAT_PATH = /^\/chats\/([^/?]+)(\/[a-z_]+(?:\/[a-z_]+)?)?$/;
const REACTION_PATH = /^\/messages\/([^/]+)\/reactions$/;

/**
 * One partner call, captured. Answers the Linq shapes the callers read:
 * `message.id` on a send, `chat.id` + `chat.message.id` on a create, the handles
 * list on GET /chats/{id}, and an empty 2xx for the effects.
 */
export async function captureLinqCall(
  input: { method: string; path: string; body?: unknown },
  sink: GroupCaptureSink,
): Promise<CapturedLinqResponse> {
  const { method, path, body } = input;

  if (method === 'POST' && path === '/chats') {
    const handles = isRecord(body) ? fakeHandles(body.to) : null;
    if (!handles) throw new PreviewGroupCaptureRefused('not_fake_handle');
    const chatId = `${PREVIEW_CHAT_PREFIX}${randomUUID()}`;
    const providerMessageId = newMessageId();
    await sink.record({
      chatId,
      kind: 'chat_create',
      method,
      path,
      body,
      handles,
      providerMessageId,
    });
    return { status: 201, payload: { chat: { id: chatId, message: { id: providerMessageId } } } };
  }

  const reaction = REACTION_PATH.exec(path);
  if (reaction && method === 'POST') {
    const messageId = decodeURIComponent(reaction[1] ?? '');
    if (!messageId.startsWith('preview-')) throw new PreviewGroupCaptureRefused('not_fake_chat');
    const chatId = await sink.chatOfMessage(messageId);
    if (!isFakeChatId(chatId)) throw new PreviewGroupCaptureRefused('not_fake_chat');
    await sink.record({
      chatId,
      kind: 'reaction',
      method,
      path,
      body,
      handles: null,
      providerMessageId: null,
    });
    return { status: 200, payload: {} };
  }

  const chat = CHAT_PATH.exec(path);
  if (!chat) throw new PreviewGroupCaptureRefused('unknown_call');
  const chatId = decodeURIComponent(chat[1] ?? '');
  if (!isFakeChatId(chatId)) throw new PreviewGroupCaptureRefused('not_fake_chat');
  const sub = chat[2] ?? '';

  if (sub === '' && method === 'GET') {
    const handles = (await sink.handlesOf(chatId)) ?? [];
    await sink.record({
      chatId,
      kind: 'chat_read',
      method,
      path,
      body: null,
      handles: null,
      providerMessageId: null,
    });
    return {
      status: 200,
      payload: {
        id: chatId,
        is_group: handles.length > 1,
        handles: handles.map((handle) => ({ handle, is_me: false })),
      },
    };
  }
  const simple: Record<string, CapturedLinqKind> = {
    'PUT:': 'chat_update',
    'PATCH:': 'chat_update',
    'POST:/read': 'mark_read',
    'POST:/typing': 'typing_start',
    'DELETE:/typing': 'typing_stop',
    'POST:/share_contact_card': 'contact_card',
    'POST:/participants': 'participant_add',
    'DELETE:/participants': 'participant_remove',
    'POST:/location/request': 'location_request',
    'GET:/location': 'location_request',
  };
  if (sub === '/polls' && method === 'POST') {
    const providerMessageId = newMessageId();
    const poll = isRecord(body) && isRecord(body.poll) ? body.poll : {};
    const texts = Array.isArray(poll.options)
      ? poll.options.map((o) => (isRecord(o) && typeof o.text === 'string' ? o.text : ''))
      : [];
    await sink.record({
      chatId,
      kind: 'poll',
      method,
      path,
      body,
      handles: null,
      providerMessageId,
    });
    return {
      status: 201,
      payload: {
        message_id: providerMessageId,
        poll: {
          options: texts.map((text, i) => ({ option_id: `${providerMessageId}-o${i}`, text })),
        },
      },
    };
  }
  if (sub === '/messages' && method === 'POST') {
    const providerMessageId = newMessageId();
    await sink.record({
      chatId,
      kind: 'message',
      method,
      path,
      body,
      handles: null,
      providerMessageId,
    });
    return { status: 202, payload: { message: { id: providerMessageId } } };
  }
  const kind = simple[`${method}:${sub}`];
  if (!kind) throw new PreviewGroupCaptureRefused('unknown_call');
  await sink.record({
    chatId,
    kind,
    method,
    path,
    body: body ?? null,
    handles: null,
    providerMessageId: null,
  });
  return { status: method === 'DELETE' ? 204 : 200, payload: method === 'DELETE' ? null : {} };
}

/** The deployed sink: Preview's own Postgres. */
export function databaseGroupCaptureSink(database?: Database): GroupCaptureSink {
  const db = async () => database ?? (await import('~/lib/db')).db();
  const t = schema.previewCapturedLinqCalls;
  return {
    async record(call) {
      await (await db()).insert(t).values({
        chatId: call.chatId,
        kind: call.kind,
        method: call.method,
        path: call.path,
        body: call.body ?? null,
        handles: call.handles,
        providerMessageId: call.providerMessageId,
      });
    },
    async chatOfMessage(messageId) {
      const d = await db();
      const [captured] = await d
        .select({ chatId: t.chatId })
        .from(t)
        .where(eq(t.providerMessageId, messageId))
        .limit(1);
      if (captured) return captured.chatId;
      const [inbound] = await d
        .select({ chatId: t.chatId })
        .from(t)
        .where(and(eq(t.kind, 'roster'), sql`${t.body}->>'messageId' = ${messageId}`))
        .limit(1);
      return inbound?.chatId ?? null;
    },
    async handlesOf(chatId) {
      const [row] = await (await db())
        .select({ handles: t.handles })
        .from(t)
        .where(and(eq(t.chatId, chatId), isNotNull(t.handles)))
        .orderBy(desc(t.capturedAt))
        .limit(1);
      return row?.handles ?? null;
    },
  };
}

/** Every captured call for one fake chat, oldest first. */
export async function readCapturedLinqCalls(database: Database, chatId: string) {
  const t = schema.previewCapturedLinqCalls;
  return database
    .select({
      kind: t.kind,
      method: t.method,
      path: t.path,
      body: t.body,
      handles: t.handles,
      providerMessageId: t.providerMessageId,
      capturedAt: t.capturedAt,
    })
    .from(t)
    .where(eq(t.chatId, chatId))
    .orderBy(asc(t.capturedAt));
}

/** Outbound ledger rows with a group-capture id and no captured call: a lost write. */
export async function countUncapturedGroupLedgerRows(database: Database): Promise<number> {
  const cm = schema.channelMessages;
  const t = schema.previewCapturedLinqCalls;
  const rows = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(cm)
    .where(
      and(
        eq(cm.direction, 'out'),
        like(cm.providerMessageId, `${PREVIEW_GROUP_CAPTURE_ID_PREFIX}%`),
        notExists(
          database
            .select({ one: sql`1` })
            .from(t)
            .where(eq(t.providerMessageId, cm.providerMessageId)),
        ),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
