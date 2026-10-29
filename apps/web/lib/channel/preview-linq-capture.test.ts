import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LinqSendError,
  createLinqChat,
  listLinqParticipantHandles,
  reactToLinqMessage,
  sendLinqChatMessage,
  setPreviewGroupCaptureSinkForTest,
  startLinqTyping,
} from './linq/transport';
import {
  handlePreviewFakeGroupInbound,
  handlePreviewGroupCapturedRead,
} from './preview-fake-group-inbound';
import {
  type CapturedLinqCall,
  type GroupCaptureSink,
  previewGroupCaptureOpen,
} from './preview-linq-capture';

/**
 * VIL-466 groups · a fake group's partner calls are captured, answered in Linq's
 * shape, and never fetched; every other chat, handle or environment is refused.
 */

function memorySink(): GroupCaptureSink & { calls: CapturedLinqCall[] } {
  const calls: CapturedLinqCall[] = [];
  return {
    calls,
    async record(call) {
      calls.push(call);
    },
    async chatOfMessage(id) {
      const hit = calls.find(
        (c) =>
          c.providerMessageId === id ||
          (c.kind === 'roster' && (c.body as { messageId?: string }).messageId === id),
      );
      return hit?.chatId ?? null;
    },
    async handlesOf(chatId) {
      return [...calls].reverse().find((c) => c.chatId === chatId && c.handles)?.handles ?? null;
    },
  };
}

const CHAT = 'preview-chat-household-1';
const A = '+14375550101';
const B = '+14375550102';
const C = '+14375550103';

function openEnv() {
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  vi.stubEnv('PREVIEW_CAPTURE_GROUPS', 'on');
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
}

let sink: ReturnType<typeof memorySink>;
const fetchSpy = vi.fn(() => {
  throw new Error('network call');
});

beforeEach(() => {
  sink = memorySink();
  setPreviewGroupCaptureSinkForTest(sink);
});

afterEach(() => {
  setPreviewGroupCaptureSinkForTest(null);
  vi.unstubAllEnvs();
  fetchSpy.mockClear();
});

describe('preview group capture gate', () => {
  it('is open only on Preview with both flags on and no Linq key or line', () => {
    openEnv();
    expect(previewGroupCaptureOpen()).toBe(true);
    expect(previewGroupCaptureOpen({ ...process.env, VERCEL_ENV: 'production' })).toBe(false);
    expect(previewGroupCaptureOpen({ ...process.env, PREVIEW_CAPTURE_GROUPS: '' })).toBe(false);
    expect(previewGroupCaptureOpen({ ...process.env, PREVIEW_CAPTURE_TRANSPORT: '' })).toBe(false);
    vi.stubEnv('LINQ_API_KEY', 'configured');
    expect(previewGroupCaptureOpen()).toBe(false);
  });

  it('keeps refusing every Linq call when the group flag is off (#924 behaviour)', async () => {
    openEnv();
    vi.stubEnv('PREVIEW_CAPTURE_GROUPS', '');
    const err = await sendLinqChatMessage({ chatId: CHAT, text: 'x', fetch: fetchSpy }).catch(
      (e: unknown) => e,
    );
    expect((err as LinqSendError).code).toBe('preview_capture');
    expect(sink.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses on production even with both flags on', async () => {
    openEnv();
    vi.stubEnv('VERCEL_ENV', 'production');
    const err = await sendLinqChatMessage({ chatId: CHAT, text: 'x', fetch: fetchSpy }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LinqSendError);
    expect(sink.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('preview group capture', () => {
  beforeEach(openEnv);

  it('captures a group message and answers with a message id, no fetch', async () => {
    const out = await sendLinqChatMessage({
      chatId: CHAT,
      text: '周六游泳谁去接？',
      fetch: fetchSpy,
    });
    expect(out.providerMessageId).toMatch(/^preview-gcapture-/);
    expect(sink.calls).toEqual([
      expect.objectContaining({
        chatId: CHAT,
        kind: 'message',
        providerMessageId: out.providerMessageId,
      }),
    ]);
    expect(JSON.stringify(sink.calls[0]?.body)).toContain('周六游泳谁去接？');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('captures a tapback on a fake inbound message and on a captured reply', async () => {
    await sink.record({
      chatId: CHAT,
      kind: 'roster',
      method: 'POST',
      path: '/preview/group-inbound',
      body: { messageId: 'preview-inbound-1' },
      handles: [A, B, C],
      providerMessageId: null,
    });
    await reactToLinqMessage({
      messageId: 'preview-inbound-1',
      operation: 'add',
      type: 'love',
      fetch: fetchSpy,
    });
    const sent = await sendLinqChatMessage({ chatId: CHAT, text: 'ok', fetch: fetchSpy });
    await reactToLinqMessage({
      messageId: sent.providerMessageId,
      operation: 'add',
      type: 'like',
      fetch: fetchSpy,
    });
    expect(sink.calls.filter((c) => c.kind === 'reaction').map((c) => c.chatId)).toEqual([
      CHAT,
      CHAT,
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a fake group only from fictional handles and reads its roster back', async () => {
    const made = await createLinqChat({ from: A, to: [B, C], text: 'hi', fetch: fetchSpy });
    expect(made.chatId).toMatch(/^preview-chat-/);
    expect(made.providerMessageId).toMatch(/^preview-gcapture-/);
    expect(await listLinqParticipantHandles({ chatId: made.chatId, fetch: fetchSpy })).toEqual(
      expect.objectContaining({}),
    );
    await expect(
      createLinqChat({ from: A, to: [B, '+14165551234'], text: 'hi' }),
    ).rejects.toMatchObject({
      code: 'preview_not_fake_handle',
      permanent: true,
    });
  });

  it('captures typing on a fake chat', async () => {
    const r = await startLinqTyping({ chatId: CHAT, fetch: fetchSpy });
    expect(r.status).toBe('accepted');
    expect(sink.calls[0]?.kind).toBe('typing_start');
  });

  it('refuses a real chat id and a tapback on a real message, before any capture', async () => {
    await expect(
      sendLinqChatMessage({ chatId: 'chat_real_123', text: 'x', fetch: fetchSpy }),
    ).rejects.toMatchObject({
      code: 'preview_not_fake_chat',
      permanent: true,
    });
    await expect(
      reactToLinqMessage({
        messageId: 'msg_real',
        operation: 'add',
        type: 'love',
        fetch: fetchSpy,
      }),
    ).rejects.toMatchObject({ code: 'preview_not_fake_chat' });
    expect(sink.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('preview fake group inbound door', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  function post(body: unknown, auth = 'Bearer s3cret') {
    return new Request('https://preview.example/api/channels/preview/group-inbound', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const env = {
    VERCEL_ENV: 'preview',
    PREVIEW_CAPTURE_TRANSPORT: 'on',
    PREVIEW_CAPTURE_GROUPS: 'on',
    PREVIEW_FAKE_INBOUND_SECRET: 's3cret',
  };
  const deps = (over: Record<string, unknown> = {}) =>
    ({
      env,
      log,
      groupSink: sink,
      database: {} as never,
      countOutcome: async () => {},
      ...over,
    }) as never;

  beforeEach(openEnv);

  it('is a plain empty 404 outside Preview', async () => {
    const res = await handlePreviewFakeGroupInbound(
      post({}),
      deps({ env: { ...env, VERCEL_ENV: 'production' } }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('is an empty 404, with no reason, when the group flag is off', async () => {
    const res = await handlePreviewFakeGroupInbound(
      post({}),
      deps({ env: { ...env, PREVIEW_CAPTURE_GROUPS: '' } }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  const read = (auth = 'Bearer s3cret') =>
    new Request(`https://preview.example/api/channels/preview/group-captured?chatId=${CHAT}`, {
      headers: { authorization: auth },
    });

  it.each([
    ['capture transport off', { PREVIEW_CAPTURE_TRANSPORT: 'off' }],
    ['group capture off', { PREVIEW_CAPTURE_GROUPS: '' }],
  ])('group inbound and group read are an empty 404 when %s', async (_label, over) => {
    const off = { ...env, ...over };
    const inbound = await handlePreviewFakeGroupInbound(post({}), deps({ env: off }));
    expect(inbound.status).toBe(404);
    expect(await inbound.text()).toBe('');
    const res = await handlePreviewGroupCapturedRead(read(), { database: {} as never, env: off });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(sink.calls).toHaveLength(0);
  });

  it.each(['LINQ_API_KEY', 'LINQ_FROM_E164', 'LINQ_WEBHOOK_SECRET'])(
    'group inbound and group read are an empty 404 when %s is set',
    async (name) => {
      vi.stubEnv(name, 'configured');
      const withLinq = { ...env, [name]: 'configured' };
      const inbound = await handlePreviewFakeGroupInbound(post({}), deps({ env: withLinq }));
      expect(inbound.status).toBe(404);
      expect(await inbound.text()).toBe('');
      const res = await handlePreviewGroupCapturedRead(read(), {
        database: {} as never,
        env: withLinq,
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(sink.calls).toHaveLength(0);
    },
  );

  it('needs the bearer', async () => {
    const res = await handlePreviewFakeGroupInbound(post({}, 'Bearer nope'), deps());
    expect(res.status).toBe(403);
  });

  it('refuses a real participant, a sender outside the group, and a real chat id', async () => {
    const real = await handlePreviewFakeGroupInbound(
      post({ from: A, participants: [A, '+14165551234'], text: 'hi' }),
      deps(),
    );
    expect(await real.json()).toMatchObject({ error: 'participants_not_fictional' });
    const outsider = await handlePreviewFakeGroupInbound(
      post({ from: C, participants: [A, B], text: 'hi' }),
      deps(),
    );
    expect(await outsider.json()).toMatchObject({ error: 'sender_not_participant' });
    const chat = await handlePreviewFakeGroupInbound(
      post({ chatId: 'chat_real', from: A, participants: [A, B], text: 'hi' }),
      deps(),
    );
    expect(await chat.json()).toMatchObject({ error: 'chat_not_fake' });
    expect(sink.calls).toHaveLength(0);
  });
});
