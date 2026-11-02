import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedLinqCall } from '~/lib/channel/preview-linq-capture';
import { captureLinqCall } from '~/lib/channel/preview-linq-capture';
import {
  type AppClipPayDecider,
  type AppClipPayDecision,
  appClipPayCopyRefusals,
  appClipPayUserMessage,
  deliverAppClipPay,
} from './app-clip-pay';
import { SANDBOX_PRICE_IDS } from './app-clip-sandbox';
import { linqAppClipPayEnabled } from './config';
import {
  LinqSendError,
  clearLinqCapabilityCacheForTest,
  setPreviewGroupCaptureSinkForTest,
} from './transport';

const CHAT = 'preview-chat-app-clip-test';
const LINE = 'Keep it for the year, whenever you are ready';

function decider(decision: AppClipPayDecision | null): AppClipPayDecider & { calls: number } {
  const fake = {
    calls: 0,
    async decide() {
      fake.calls += 1;
      return decision;
    },
  };
  return fake;
}

const OFFER: AppClipPayDecision = { offer: true, tier: 'plus', description: LINE };

let calls: CapturedLinqCall[];

beforeEach(() => {
  clearLinqCapabilityCacheForTest();
  for (const name of [
    'VERCEL_ENV',
    'PREVIEW_CAPTURE_TRANSPORT',
    'PREVIEW_CAPTURE_GROUPS',
    'LINQ_API_KEY',
    'LINQ_FROM_E164',
    'LINQ_WEBHOOK_SECRET',
    'LINQ_APP_CLIP_PAY_ENABLED',
    'STRIPE_SECRET_KEY',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  vi.stubEnv('PREVIEW_CAPTURE_GROUPS', 'on');
  vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', 'true');
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

function messageParts(): Array<{ type: string; value?: string }> {
  return calls.flatMap((call) => {
    const body = call.body as { message?: { parts?: Array<{ type: string; value?: string }> } };
    return body?.message?.parts ?? [];
  });
}

describe('LINQ_APP_CLIP_PAY_ENABLED', () => {
  it('is dark unless Preview and exactly true', () => {
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', '');
    expect(linqAppClipPayEnabled()).toBe(false);
    for (const value of ['on', 'false', '1', 'TRUE']) {
      vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', value);
      expect(linqAppClipPayEnabled()).toBe(false);
    }
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', 'true\n');
    expect(linqAppClipPayEnabled()).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(linqAppClipPayEnabled()).toBe(false);
  });
});

describe('app clip pay copy', () => {
  it('hands the model the audience, the plan, and the parent message', () => {
    expect(
      JSON.parse(
        appClipPayUserMessage({ audience: 'direct', planTier: 'free', parentText: 'plus?' }),
      ),
    ).toEqual({ audience: 'direct', planTier: 'free', parentText: 'plus?' });
  });

  it('refuses an empty line, a price, a URL, or more than one line', () => {
    expect(appClipPayCopyRefusals('   ')).toContain('empty');
    expect(appClipPayCopyRefusals('Plus is $79')).toContain('price');
    expect(appClipPayCopyRefusals('see https://pay.example')).toContain('url');
    expect(appClipPayCopyRefusals('one\ntwo')).toContain('not_one_line');
    expect(appClipPayCopyRefusals(LINE)).toEqual([]);
  });
});

describe('deliverAppClipPay', () => {
  const read = {
    audience: 'direct' as const,
    planTier: 'free' as const,
    parentText: 'can I pay for plus here',
  };

  it('flag dark: does not ask the model and sends nothing', async () => {
    vi.stubEnv('LINQ_APP_CLIP_PAY_ENABLED', '');
    const model = decider(OFFER);
    const out = await deliverAppClipPay({
      channel: 'imessage',
      chatId: CHAT,
      read,
      decider: model,
    });
    expect(out).toEqual({ status: 'not_sent', reason: 'dark' });
    expect(model.calls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a Linq key or a live Stripe key sends nothing, and does not ask the model', async () => {
    const model = decider(OFFER);
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    expect(
      await deliverAppClipPay({ channel: 'imessage', chatId: CHAT, read, decider: model }),
    ).toEqual({ status: 'not_sent', reason: 'live_key' });
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_not_a_real_key');
    expect(
      await deliverAppClipPay({ channel: 'imessage', chatId: CHAT, read, decider: model }),
    ).toEqual({ status: 'not_sent', reason: 'live_key' });
    expect(model.calls).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a model that cannot write, declines, or names a price sends nothing', async () => {
    for (const decision of [
      null,
      { offer: false, tier: null, description: null },
      { offer: true, tier: 'plus' as const, description: '   ' },
      { offer: true, tier: 'plus' as const, description: 'It is $79 a year' },
    ]) {
      calls.length = 0;
      const out = await deliverAppClipPay({
        channel: 'imessage',
        chatId: CHAT,
        read,
        decider: decider(decision),
      });
      expect(out.status).toBe('not_sent');
      expect(calls).toEqual([]);
    }
  });

  it('sends one app_clip part and a sandbox request whose description is the model line', async () => {
    const out = await deliverAppClipPay({
      channel: 'imessage',
      chatId: CHAT,
      read,
      decider: decider(OFFER),
    });
    expect(out.status).toBe('card');
    const payment = calls.find((call) => call.kind === 'payment_request');
    expect(payment?.body).toMatchObject({
      livemode: false,
      mode: 'subscription',
      description: LINE,
      price_id: SANDBOX_PRICE_IDS.plus,
      metadata: { hale_payment_mode: 'sandbox', tier: 'plus' },
    });
    expect(payment?.body).not.toHaveProperty('amount');
    const parts = messageParts();
    expect(parts).toEqual([
      { type: 'app_clip', value: out.status === 'card' ? out.checkoutUrl : '' },
    ]);
    expect(parts.some((part) => part.type === 'text')).toBe(false);
    expect(JSON.stringify(parts)).not.toContain(LINE);
  });

  it('on 4005, sends the same sandbox URL as a link and no text', async () => {
    const out = await deliverAppClipPay({
      channel: 'imessage',
      chatId: CHAT,
      read,
      decider: decider(OFFER),
      unreachable: true,
    });
    expect(out.status).toBe('fallback');
    const parts = messageParts();
    expect(parts.map((part) => part.type)).toEqual(['app_clip', 'link']);
    expect(parts[0]?.value).toBe(parts[1]?.value);
    expect(parts[0]?.value?.startsWith('https://sandbox.pay.preview.invalid/')).toBe(true);
    expect(parts.some((part) => part.type === 'text')).toBe(false);
  });

  it('a synchronous 4005 falls back to the link and does not leave a text', async () => {
    const { sendLinqParts } = await import('~/lib/channel/outbound-transport');
    const out = await deliverAppClipPay({
      channel: 'imessage',
      chatId: CHAT,
      read,
      decider: decider(OFFER),
      sendParts: async (input) => {
        if (input.parts[0]?.type === 'app_clip') throw new LinqSendError('4005', 422, true);
        return sendLinqParts(input);
      },
    });
    expect(out.status).toBe('fallback');
    expect(messageParts().map((part) => part.type)).toEqual(['link']);
  });

  it('a group chat sends nothing', async () => {
    const model = decider(OFFER);
    const out = await deliverAppClipPay({
      channel: 'imessage',
      chatId: CHAT,
      isGroup: true,
      read,
      decider: model,
    });
    expect(out).toEqual({ status: 'not_sent', reason: 'group_chat' });
    expect(model.calls).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('capture refuses a live payment body', () => {
  it('does not mint a checkout URL when livemode is not false', async () => {
    const sink = {
      record: async (call: CapturedLinqCall) => {
        calls.push(call);
      },
      chatOfMessage: async () => null,
      handlesOf: async () => null,
    };
    await expect(
      captureLinqCall(
        {
          method: 'POST',
          path: '/payment_requests',
          body: { livemode: true, amount: 7900, currency: 'cad', description: LINE },
        },
        sink,
      ),
    ).rejects.toThrow(/unknown_call/);
    expect(calls).toEqual([]);
  });
});
