import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyInboundMedia, mediaPartFromLinq, persistableMedia } from '../inbound-media';
import type { CapturedLinqCall, GroupCaptureSink } from '../preview-linq-capture';
import {
  IMESSAGE_CAPABILITY_TTL_MS,
  LinqSendError,
  checkLinqIMessageCapability,
  clearLinqCapabilityCacheForTest,
  forgetLinqIMessageCapability,
  sendLinqVoiceMemo,
  setPreviewGroupCaptureSinkForTest,
} from './transport';

/** VIL-476 · capability check (cached) + native voice memo + inbound audio, all dark by default. */

const API_KEY = 'linq_test_key_not_a_secret';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const PHONE = '+14375550101';

function jsonFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
}

beforeEach(() => {
  clearLinqCapabilityCacheForTest();
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
  vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', '');
});

afterEach(() => {
  setPreviewGroupCaptureSinkForTest(null);
  vi.unstubAllEnvs();
});

describe('checkLinqIMessageCapability', () => {
  it('is dark by default and never fetches', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(200, { available: true });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: f })).toEqual({
      status: 'unknown',
      reason: 'dark',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('is not_configured with keys unset', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    const f = jsonFetch(200, { available: true });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: f })).toEqual({
      status: 'unknown',
      reason: 'not_configured',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the address, caches the answer inside the TTL, and re-asks after it', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(200, { address: PHONE, available: true, selected_service: 'iMessage' });
    let t = 1_000;
    const now = () => t;
    const first = await checkLinqIMessageCapability({ address: PHONE, fetch: f, now });
    expect(first).toEqual({ status: 'available', selectedService: 'iMessage', cached: false });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.linqapp.com/api/partner/v3/capability/check_imessage');
    expect(JSON.parse(String(init.body))).toEqual({ address: PHONE });

    t += IMESSAGE_CAPABILITY_TTL_MS - 1;
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: f, now })).toMatchObject({
      status: 'available',
      cached: true,
    });
    expect(f).toHaveBeenCalledTimes(1);

    t += 2;
    await checkLinqIMessageCapability({ address: PHONE, fetch: f, now });
    expect(f).toHaveBeenCalledTimes(2);

    forgetLinqIMessageCapability(PHONE);
    await checkLinqIMessageCapability({ address: PHONE, fetch: f, now });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('caches a negative answer as not_available', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(200, {
      available: false,
      reason: 'not_supported',
      selected_service: 'SMS',
    });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: f })).toEqual({
      status: 'not_available',
      selectedService: 'SMS',
      cached: false,
    });
  });

  it('reads a rate limit as unknown and does not cache it', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const limited = jsonFetch(429, { error: { code: 1007 } }, { 'retry-after': '30' });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: limited })).toEqual({
      status: 'unknown',
      reason: 'rate_limited',
    });
    const ok = jsonFetch(200, { available: true });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: ok })).toMatchObject({
      status: 'available',
      cached: false,
    });
  });
});

describe('sendLinqVoiceMemo', () => {
  it('refuses while dark, before any fetch', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(202, {});
    await expect(
      sendLinqVoiceMemo({ chatId: CHAT, audio: { url: 'https://x.test/a.m4a' }, fetch: f }),
    ).rejects.toMatchObject({ code: 'voice_memos_dark' });
    expect(f).not.toHaveBeenCalled();
  });

  it('posts voice_memo_url alone to /voicememo and returns the message id', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(202, { message: { id: 'msg-1' } });
    const out = await sendLinqVoiceMemo({
      chatId: CHAT,
      audio: { url: 'https://cdn.test/memo.m4a' },
      fetch: f,
    });
    expect(out).toEqual({ providerMessageId: 'msg-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.linqapp.com/api/partner/v3/chats/${CHAT}/voicememo`);
    expect(JSON.parse(String(init.body))).toEqual({ voice_memo_url: 'https://cdn.test/memo.m4a' });
  });

  it('sends a pre-uploaded attachment_id', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const f = jsonFetch(202, { message: { id: 'msg-2' } });
    await sendLinqVoiceMemo({ chatId: CHAT, audio: { attachmentId: 'att-1' }, fetch: f });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ attachment_id: 'att-1' });
  });

  it('refuses a non-https url and surfaces a Linq refusal', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    await expect(
      sendLinqVoiceMemo({ chatId: CHAT, audio: { url: 'http://cdn.test/memo.m4a' } }),
    ).rejects.toMatchObject({ code: 'invalid_voice_memo' });
    const f = jsonFetch(400, { error: { code: 2001 } });
    const err = await sendLinqVoiceMemo({
      chatId: CHAT,
      audio: { url: 'https://cdn.test/memo.m4a' },
      fetch: f,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LinqSendError);
    expect(err).toMatchObject({ code: '2001', permanent: true });
  });
});

describe('Preview capture', () => {
  function memorySink(): GroupCaptureSink & { calls: CapturedLinqCall[] } {
    const calls: CapturedLinqCall[] = [];
    return {
      calls,
      async record(call) {
        calls.push(call);
      },
      async chatOfMessage() {
        return null;
      },
      async handlesOf() {
        return null;
      },
    };
  }

  function openEnv() {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.stubEnv('PREVIEW_CAPTURE_GROUPS', 'on');
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
  }

  it('captures a fake-handle capability check and a fake-chat voice memo, never fetching', async () => {
    openEnv();
    const sink = memorySink();
    setPreviewGroupCaptureSinkForTest(sink);
    const f = vi.fn(() => {
      throw new Error('network call');
    });
    expect(await checkLinqIMessageCapability({ address: PHONE, fetch: f })).toMatchObject({
      status: 'available',
    });
    const out = await sendLinqVoiceMemo({
      chatId: 'preview-chat-household-1',
      audio: { url: 'https://cdn.test/memo.m4a' },
      fetch: f,
    });
    expect(out.providerMessageId).toMatch(/^preview-gcapture-/);
    expect(sink.calls.map((c) => c.kind)).toEqual(['capability_check', 'voice_memo']);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a real handle and a real chat', async () => {
    openEnv();
    setPreviewGroupCaptureSinkForTest(memorySink());
    await expect(checkLinqIMessageCapability({ address: '+14165550199' })).rejects.toMatchObject({
      code: 'preview_not_fake_handle',
    });
    await expect(
      sendLinqVoiceMemo({ chatId: CHAT, audio: { url: 'https://cdn.test/memo.m4a' } }),
    ).rejects.toMatchObject({ code: 'preview_not_fake_chat' });
  });
});

describe('inbound audio', () => {
  it('reads as a file while dark, exactly as before', () => {
    expect(classifyInboundMedia('audio/x-m4a', null, null, false)).toBe('file');
    expect(classifyInboundMedia(null, 'https://cdn.test/a.caf', null, false)).toBe('file');
  });

  it('reads as audio with the flag on, by mime or by extension, and persists', () => {
    expect(classifyInboundMedia('audio/x-m4a', null, null, true)).toBe('audio');
    expect(classifyInboundMedia(null, 'https://cdn.test/Audio%20Message.caf', null, true)).toBe(
      'audio',
    );
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    const part = mediaPartFromLinq({
      type: 'media',
      url: 'https://cdn.test/m.caf',
      mime_type: 'audio/x-caf',
    });
    expect(part.kind).toBe('audio');
    expect(persistableMedia([part])?.[0]?.kind).toBe('audio');
  });
});
