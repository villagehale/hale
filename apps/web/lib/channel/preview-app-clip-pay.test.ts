import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppClipPayDecision } from './linq/app-clip-pay';
import {
  clearLinqCapabilityCacheForTest,
  setPreviewGroupCaptureSinkForTest,
} from './linq/transport';
import { fakeAppClipChatId, handlePreviewAppClipPay } from './preview-app-clip-pay';
import type { CapturedLinqCall } from './preview-linq-capture';

const SECRET = 'preview-secret-test';
const env = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_CAPTURE_GROUPS: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
  LINQ_APP_CLIP_PAY_ENABLED: 'true',
};
const LINE = 'Whenever you want to keep it';
const OFFER: AppClipPayDecision = {
  offer: true,
  tier: 'family',
  description: LINE,
  line: null,
};
const BUBBLE = 'Here is the link';

function req(body: unknown, secret = SECRET) {
  return new Request('https://preview.test/api/channels/preview/app-clip-pay', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let calls: CapturedLinqCall[];

beforeEach(() => {
  clearLinqCapabilityCacheForTest();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('LINQ_FROM_E164', '');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', '');
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  calls = [];
  setPreviewGroupCaptureSinkForTest({
    record: async (call) => {
      calls.push(call);
    },
    chatOfMessage: async () => null,
    handlesOf: async () => null,
  });
});

afterEach(() => {
  setPreviewGroupCaptureSinkForTest(null);
  vi.unstubAllEnvs();
});

describe('POST /api/channels/preview/app-clip-pay (VIL-481)', () => {
  const body = {
    to: '+14375550101',
    parentText: 'can we do family with apple pay',
    planTier: 'free',
  };
  const model = { decide: async () => OFFER };

  it('captures one App Clip card for a fictional handle, with the model line only on the sandbox request', async () => {
    const res = await handlePreviewAppClipPay(req(body), { env, decider: model });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.outcome.status).toBe('card');
    expect(json.chatId).toBe(fakeAppClipChatId('+14375550101'));
    const payment = calls.find((call) => call.kind === 'payment_request');
    expect((payment?.body as { description?: string; livemode?: boolean }).livemode).toBe(false);
    expect((payment?.body as { description?: string }).description).toBe(LINE);
    const parts = calls.flatMap((call) => {
      const message = call.body as { message?: { parts?: Array<{ type: string; value: string }> } };
      return message?.message?.parts ?? [];
    });
    expect(parts).toEqual([
      {
        type: 'app_clip',
        value: expect.stringMatching(/^https:\/\/sandbox\.pay\.preview\.invalid\//),
      },
    ]);
    expect(JSON.stringify(json)).not.toContain(LINE);
  });

  it('failedCode 4005 is the line and the link, not the card', async () => {
    const res = await handlePreviewAppClipPay(req({ ...body, failedCode: 4005 }), {
      env,
      decider: {
        decide: async () => ({
          offer: true,
          tier: 'family' as const,
          description: LINE,
          line: BUBBLE,
        }),
      },
    });
    const json = await res.json();
    expect(json.outcome.status).toBe('link');
    const parts = calls.flatMap((call) => {
      const message = call.body as { message?: { parts?: Array<{ type: string; value: string }> } };
      return message?.message?.parts ?? [];
    });
    expect(parts.map((part) => part.type)).toEqual(['text', 'link']);
    expect(parts[0]?.value).toBe(BUBBLE);
    expect(parts[1]?.value).toBe(parts.find((part) => part.type === 'link')?.value);
    expect(parts.some((part) => part.type === 'app_clip')).toBe(false);
  });

  it('failedCode 4005 with no fresh line sends nothing', async () => {
    const res = await handlePreviewAppClipPay(req({ ...body, failedCode: 4005 }), {
      env,
      decider: model,
    });
    const json = await res.json();
    expect(json.outcome).toEqual({ status: 'not_sent', reason: 'unwritten' });
    expect(calls.filter((call) => call.kind === 'message')).toEqual([]);
  });

  it('a model that writes nothing sends nothing', async () => {
    const res = await handlePreviewAppClipPay(req(body), {
      env,
      decider: { decide: async () => null },
    });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.outcome).toEqual({ status: 'not_sent', reason: 'unwritten' });
    expect(calls).toEqual([]);
  });

  it('is 409 when dark, 400 for a real number, 404 outside Preview', async () => {
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', '');
    expect((await handlePreviewAppClipPay(req(body), { env, decider: model })).status).toBe(409);
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', 'true');
    expect(
      (await handlePreviewAppClipPay(req({ ...body, to: '+14165551234' }), { env, decider: model }))
        .status,
    ).toBe(400);
    expect(
      (
        await handlePreviewAppClipPay(req(body), {
          env: { ...env, VERCEL_ENV: 'production' },
          decider: model,
        })
      ).status,
    ).toBe(404);
  });
});
