import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundRouteDeps } from '~/lib/channel/inbound-route';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { persistCapturedSend } from './preview-capture-store';
import { createPreviewCaptureTransport } from './preview-capture-transport';

const routeInboundText = vi.fn(async () => 'intake' as const);
vi.mock('~/lib/channel/inbound-route', () => ({
  routeInboundText: (...args: unknown[]) => routeInboundText(...(args as [])),
}));

const { handlePreviewCapturedRead, handlePreviewFakeInbound, previewFakeInboundRefusal } =
  await import('./preview-fake-inbound');

const SECRET = 'preview-fake-inbound-test-secret';
const ON = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
};
const FAKE = '+14375550142';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  routeInboundText.mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

function deps(env: Record<string, string | undefined>): InboundRouteDeps & { env: typeof env } {
  return {
    database: t.database,
    intake: () => {
      throw new Error('intake is built by the router, which is mocked here');
    },
    enqueue: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    env,
  };
}

function post(body: unknown, secret: string | null = SECRET): Request {
  return new Request('https://preview.example/api/channels/preview/inbound', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('preview fake inbound gate', () => {
  it('is off in production, even with every other switch on', async () => {
    const env = { ...ON, VERCEL_ENV: 'production' };
    expect(previewFakeInboundRefusal(env)).toBe('not_preview');
    const res = await handlePreviewFakeInbound(post({ from: FAKE, text: 'hi' }), deps(env));
    expect(res.status).toBe(404);
    expect(routeInboundText).not.toHaveBeenCalled();
  });

  it('is off locally (no VERCEL_ENV)', () => {
    expect(previewFakeInboundRefusal({ ...ON, VERCEL_ENV: undefined })).toBe('not_preview');
  });

  it('is off when the capture transport is off', () => {
    expect(previewFakeInboundRefusal({ ...ON, PREVIEW_CAPTURE_TRANSPORT: 'yes' })).toBe(
      'capture_off',
    );
  });

  it.each(['LINQ_API_KEY', 'LINQ_FROM_E164', 'LINQ_WEBHOOK_SECRET'])(
    'is off when %s is set',
    async (name) => {
      const env = { ...ON, [name]: 'configured' };
      expect(previewFakeInboundRefusal(env)).toBe('linq_configured');
      const res = await handlePreviewFakeInbound(post({ from: FAKE, text: 'hi' }), deps(env));
      expect(res.status).toBe(404);
      expect(routeInboundText).not.toHaveBeenCalled();
    },
  );

  it('is off without its own secret', () => {
    expect(previewFakeInboundRefusal({ ...ON, PREVIEW_FAKE_INBOUND_SECRET: ' ' })).toBe(
      'secret_unset',
    );
  });

  it('rejects a wrong or missing bearer', async () => {
    for (const secret of ['wrong', null]) {
      const res = await handlePreviewFakeInbound(
        post({ from: FAKE, text: 'hi' }, secret),
        deps(ON),
      );
      expect(res.status).toBe(401);
    }
    expect(routeInboundText).not.toHaveBeenCalled();
  });

  it('refuses a sender outside the fictional probe range', async () => {
    const res = await handlePreviewFakeInbound(
      post({ from: '+14165550142', text: 'hi' }),
      deps(ON),
    );
    expect(res.status).toBe(400);
    expect(routeInboundText).not.toHaveBeenCalled();
  });
});

describe('preview fake inbound routing', () => {
  it('feeds the same router as the Linq door, with the text as written', async () => {
    const res = await handlePreviewFakeInbound(
      post({ from: FAKE, text: 'HALE OSSINGTON' }),
      deps(ON),
    );
    expect(res.status).toBe(200);
    expect(routeInboundText).toHaveBeenCalledTimes(1);
    const [, inbound] = routeInboundText.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(inbound).toMatchObject({ from: FAKE, body: 'HALE OSSINGTON', transport: 'sms' });
    expect(String(inbound.providerId)).toMatch(/^preview-inbound-/);
    expect(inbound.media).toBeUndefined();
  });

  it('carries a photo attachment, with no text', async () => {
    const res = await handlePreviewFakeInbound(
      post({
        from: FAKE,
        text: '',
        media: [{ url: 'https://example.com/flyer.jpg', mime: 'image/jpeg' }],
      }),
      deps(ON),
    );
    expect(res.status).toBe(200);
    const [, inbound] = routeInboundText.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(inbound.media).toEqual([
      { kind: 'image', url: 'https://example.com/flyer.jpg', mime: 'image/jpeg' },
    ]);
  });

  it('refuses a non-https attachment', async () => {
    const res = await handlePreviewFakeInbound(
      post({ from: FAKE, text: 'x', media: [{ url: 'http://example.com/a.jpg' }] }),
      deps(ON),
    );
    expect(res.status).toBe(400);
  });
});

describe('captured sends read back word for word', () => {
  it('persists each capture and reads it back for that number only', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const transport = createPreviewCaptureTransport(ON, (send) =>
      persistCapturedSend(send, t.database),
    );
    await transport.send({ to: FAKE, body: 'Bonjour ! Première ligne.' });
    await transport.send({ to: '+14375550199', body: 'other family' });
    await transport.send({ to: FAKE, body: '第二条' });

    const rows = await t.database.select().from(schema.previewCapturedSends);
    expect(rows).toHaveLength(3);

    const req = new Request(
      `https://preview.example/api/channels/preview/captured?to=${encodeURIComponent(FAKE)}`,
      { headers: { authorization: `Bearer ${SECRET}` } },
    );
    const res = await handlePreviewCapturedRead(req, { database: t.database, env: ON });
    const body = (await res.json()) as {
      count: number;
      uncapturedLedgered: number;
      sends: Array<{ body: string }>;
    };
    expect(body.sends.map((s) => s.body)).toEqual(['Bonjour ! Première ligne.', '第二条']);
    expect(body.count).toBe(2);
    expect(body.uncapturedLedgered).toBe(0);
  });

  it('read-back shows a mismatch when a ledgered capture was never persisted', async () => {
    const seeded = await seedFamily(t.database);
    // One persisted capture with its ledger row, one ledger row whose persist failed.
    await persistCapturedSend(
      {
        to: FAKE,
        body: 'kept',
        providerMessageId: 'preview-capture-1-1',
        capturedAt: new Date().toISOString(),
      },
      t.database,
    );
    for (const providerMessageId of ['preview-capture-1-1', 'preview-capture-1-2']) {
      await t.database.insert(schema.channelMessages).values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        providerMessageId,
      });
    }
    const req = new Request(
      `https://preview.example/api/channels/preview/captured?to=${encodeURIComponent(FAKE)}`,
      { headers: { authorization: `Bearer ${SECRET}` } },
    );
    const res = await handlePreviewCapturedRead(req, { database: t.database, env: ON });
    const body = (await res.json()) as { count: number; uncapturedLedgered: number };
    expect(body.count).toBe(1);
    expect(body.uncapturedLedgered).toBe(1);
  });

  it('the store refuses a real (non 437-555) number and writes nothing', async () => {
    await expect(
      persistCapturedSend(
        {
          to: '+14165550142',
          body: 'real parent words',
          providerMessageId: 'preview-capture-2-1',
          capturedAt: new Date().toISOString(),
        },
        t.database,
      ),
    ).rejects.toThrow(/recipient_not_synthetic/);
    expect(await t.database.select().from(schema.previewCapturedSends)).toHaveLength(0);
  });

  it('read route is off in production', async () => {
    const req = new Request(
      `https://x/api/channels/preview/captured?to=${encodeURIComponent(FAKE)}`,
      {
        headers: { authorization: `Bearer ${SECRET}` },
      },
    );
    const res = await handlePreviewCapturedRead(req, {
      database: t.database,
      env: { ...ON, VERCEL_ENV: 'production' },
    });
    expect(res.status).toBe(404);
  });
});
