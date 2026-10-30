import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLinqCapabilityCacheForTest,
  setPreviewGroupCaptureSinkForTest,
} from './linq/transport';
import { fakeExperienceChatId, handlePreviewExperienceCard } from './preview-experience-card';
import type { CapturedLinqCall } from './preview-linq-capture';

const SECRET = 'preview-secret-test';
const env = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_CAPTURE_GROUPS: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
};
function req(body: unknown, secret = SECRET) {
  return new Request('https://preview.test/api/channels/preview/experience-card', {
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
  vi.stubEnv('LINQ_EXPERIENCES_ENABLED', 'true');
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

describe('POST /api/channels/preview/experience-card (VIL-480)', () => {
  const card = {
    to: '+14375550101',
    url: 'https://villagehale.com/e/test',
    fallbackText: 'Swim Sat 10am',
  };

  it('captures one experience card for a fictional handle', async () => {
    const res = await handlePreviewExperienceCard(req(card), { env });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.outcome.status).toBe('card');
    expect(body.chatId).toBe(fakeExperienceChatId('+14375550101'));
    const sent = calls.find((c) => (c.body as any)?.message?.experience);
    expect((sent?.body as any).message).toEqual({
      experience: {
        name: 'link',
        action: 'open',
        params: { url: card.url, title: card.fallbackText },
      },
    });
  });

  it('asGroup falls back to the link preview', async () => {
    const res = await handlePreviewExperienceCard(req({ ...card, asGroup: true }), { env });
    const body = await res.json();
    expect(body.outcome).toMatchObject({ status: 'fallback', why: 'group_chat' });
    expect(calls.some((c) => (c.body as any)?.message?.experience)).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('is 409 when dark, 400 for a real number, 404 outside Preview', async () => {
    vi.stubEnv('LINQ_EXPERIENCES_ENABLED', '');
    expect((await handlePreviewExperienceCard(req(card), { env })).status).toBe(409);
    vi.stubEnv('LINQ_EXPERIENCES_ENABLED', 'true');
    expect(
      (await handlePreviewExperienceCard(req({ ...card, to: '+14165551234' }), { env })).status,
    ).toBe(400);
    expect(
      (await handlePreviewExperienceCard(req(card), { env: { ...env, VERCEL_ENV: 'production' } }))
        .status,
    ).toBe(404);
  });
});
