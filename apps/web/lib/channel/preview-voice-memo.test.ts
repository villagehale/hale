import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLinqCapabilityCacheForTest,
  setPreviewGroupCaptureSinkForTest,
} from './linq/transport';
import type { CapturedLinqCall } from './preview-linq-capture';
import { fakeOneToOneChatId, handlePreviewVoiceMemo } from './preview-voice-memo';

const SECRET = 'preview-secret-test';
const env = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_CAPTURE_GROUPS: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
};

function req(body: unknown, secret = SECRET) {
  return new Request('https://preview.test/api/channels/preview/voice-memo', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let calls: CapturedLinqCall[];
beforeEach(() => {
  clearLinqCapabilityCacheForTest();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
  vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
  calls = [];
  setPreviewGroupCaptureSinkForTest({
    record: async (c) => {
      calls.push(c);
    },
    chatOfMessage: async () => null,
    handlesOf: async () => null,
  });
});
afterEach(() => {
  setPreviewGroupCaptureSinkForTest(null);
  vi.unstubAllEnvs();
});

describe('POST /api/channels/preview/voice-memo (VIL-476)', () => {
  it('captures the capability check and one voice memo for a fictional handle', async () => {
    const res = await handlePreviewVoiceMemo(
      req({ to: '+14375550101', audioUrl: 'https://cdn.test/memo.m4a' }),
      { env },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ capability: 'available', sent: true });
    expect(body.chatId).toBe(fakeOneToOneChatId('+14375550101'));
    expect(calls.map((c) => c.kind)).toEqual(['capability_check', 'voice_memo']);
  });

  it('refuses a real number and a wrong bearer, and is 404 outside Preview', async () => {
    expect(
      (
        await handlePreviewVoiceMemo(req({ to: '+14165550199', audioUrl: 'https://x.test/a' }), {
          env,
        })
      ).status,
    ).toBe(400);
    expect((await handlePreviewVoiceMemo(req({}, 'nope'), { env })).status).toBe(403);
    expect(
      (await handlePreviewVoiceMemo(req({}), { env: { ...env, VERCEL_ENV: 'production' } })).status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it('is 409 while the flag is dark', async () => {
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', '');
    const res = await handlePreviewVoiceMemo(
      req({ to: '+14375550101', audioUrl: 'https://x.test/a' }),
      {
        env,
      },
    );
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });
});
