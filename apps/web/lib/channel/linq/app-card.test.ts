import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCardBodyIsSafe, buildLinqAppCard, sendLinqAppCard } from './app-card';
import { describeInboundAppCard } from './app-card-inbound';
import { linqAppCardsEnabled, linqIMessageAppIdentity } from './config';
import { parseLinqWebhook } from './payload';
import { clearLinqCapabilityCacheForTest, sendLinqParts } from './transport';

/** VIL-480 · iMessage app cards, dark by default, with a link-preview fallback. Keys unset. */

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const APP = { name: 'Hale', team_id: 'ABCDE12345', bundle_id: 'com.villagehale.messages' };
const CARD = {
  url: 'https://villagehale.com/e/abc123',
  fallbackText: 'Event details inside',
  caption: 'Saturday story time',
  subcaption: '10:30 AM · Lillian H. Smith library',
  imageUrl: 'https://villagehale.com/e/abc123.jpg',
  imageTitle: 'Story time',
};

function jsonFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function lit() {
  vi.stubEnv('LINQ_APP_CARDS_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_IMESSAGE_APP_NAME', APP.name);
  vi.stubEnv('LINQ_IMESSAGE_APP_TEAM_ID', APP.team_id);
  vi.stubEnv('LINQ_IMESSAGE_APP_BUNDLE_ID', APP.bundle_id);
}

beforeEach(() => {
  clearLinqCapabilityCacheForTest();
  for (const name of [
    'VERCEL_ENV',
    'PREVIEW_CAPTURE_TRANSPORT',
    'LINQ_API_KEY',
    'LINQ_FROM_E164',
    'LINQ_WEBHOOK_SECRET',
    'LINQ_VOICE_MEMOS_ENABLED',
    'LINQ_APP_CARDS_ENABLED',
    'LINQ_IMESSAGE_APP_NAME',
    'LINQ_IMESSAGE_APP_TEAM_ID',
    'LINQ_IMESSAGE_APP_BUNDLE_ID',
    'LINQ_IMESSAGE_APP_STORE_ID',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('flag + identity', () => {
  it('is dark unless exactly true', () => {
    expect(linqAppCardsEnabled()).toBe(false);
    for (const v of ['on', 'false', '1', 'TRUE']) {
      vi.stubEnv('LINQ_APP_CARDS_ENABLED', v);
      expect(linqAppCardsEnabled()).toBe(false);
    }
    vi.stubEnv('LINQ_APP_CARDS_ENABLED', 'true\n');
    expect(linqAppCardsEnabled()).toBe(true);
  });

  it('needs name, a 10-char team id, and bundle id', () => {
    expect(linqIMessageAppIdentity()).toBeNull();
    lit();
    expect(linqIMessageAppIdentity()).toEqual(APP);
    vi.stubEnv('LINQ_IMESSAGE_APP_TEAM_ID', 'short');
    expect(linqIMessageAppIdentity()).toBeNull();
  });
});

describe('fallback_text safety (iMessage drops a card whose body has a time/date/address/phone/day)', () => {
  it.each([
    'Starts at 11:30 AM',
    'See you tomorrow',
    'Due Jan 15',
    '123 Example Ave',
    'Call 416 555 0100',
    'Saturday fun',
    'rendez-vous demain',
    '明天见',
  ])('rejects %s', (body) => expect(appCardBodyIsSafe(body)).toBe(false));
  it.each(['Event details inside', 'Tap to RSVP', 'Location inside'])('allows %s', (body) =>
    expect(appCardBodyIsSafe(body)).toBe(true),
  );
});

describe('buildLinqAppCard', () => {
  it('builds the wire part with only set layout fields', () => {
    const built = buildLinqAppCard(CARD, APP);
    expect(built).toEqual({
      ok: true,
      card: {
        app: APP,
        url: CARD.url,
        fallback_text: CARD.fallbackText,
        layout: {
          caption: CARD.caption,
          subcaption: CARD.subcaption,
          image_url: CARD.imageUrl,
          image_title: CARD.imageTitle,
        },
      },
    });
  });
  it('refuses http, empty layout, overlay without image, unsafe body', () => {
    expect(buildLinqAppCard({ ...CARD, url: 'http://x.test' }, APP)).toMatchObject({ ok: false });
    expect(buildLinqAppCard({ url: CARD.url, fallbackText: 'Inside' }, APP)).toEqual({
      ok: false,
      why: 'invalid_card',
    });
    expect(
      buildLinqAppCard({ url: CARD.url, fallbackText: 'Inside', imageTitle: 'x' }, APP),
    ).toEqual({ ok: false, why: 'invalid_card' });
    expect(buildLinqAppCard({ ...CARD, fallbackText: 'Tonight at 7' }, APP)).toEqual({
      ok: false,
      why: 'unsafe_fallback_text',
    });
  });
  it('passes interactive:false through', () => {
    const built = buildLinqAppCard({ ...CARD, interactive: false }, APP);
    expect(built.ok && built.card.interactive).toBe(false);
  });
});

describe('transport part rules', () => {
  it('an imessage_app part must be alone', async () => {
    lit();
    const built = buildLinqAppCard(CARD, APP);
    if (!built.ok) throw new Error('build');
    const fetchImpl = jsonFetch(202, { message: { id: 'm1' } });
    await expect(
      sendLinqParts({
        chatId: CHAT,
        parts: [
          { type: 'text', value: 'hi' },
          { type: 'imessage_app', card: built.card },
        ],
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'app_card_not_alone' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sendLinqAppCard', () => {
  it('dark: no app part, falls back to the link preview of the card url', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchImpl = jsonFetch(202, { message: { id: 'link-1' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'dark', link: { status: 'sent' } });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.message.parts).toEqual([{ type: 'link', value: CARD.url }]);
  });

  it('keys unset: nothing reaches Linq at all', async () => {
    const fetchImpl = jsonFetch(202, {});
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', link: { status: 'not_sent' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lit: one imessage_app part to /chats/{id}/messages', async () => {
    lit();
    const fetchImpl = jsonFetch(202, { message: { id: 'card-1' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toEqual({ status: 'card', providerMessageId: 'card-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/chats/${CHAT}/messages`);
    const part = JSON.parse(String(init?.body)).message.parts[0];
    expect(part).toMatchObject({
      type: 'imessage_app',
      app: APP,
      url: CARD.url,
      fallback_text: CARD.fallbackText,
    });
    expect(part.layout.image_title).toBe('Story time');
  });

  it('lit but no app identity → link fallback', async () => {
    lit();
    vi.stubEnv('LINQ_IMESSAGE_APP_BUNDLE_ID', '');
    const fetchImpl = jsonFetch(202, { message: { id: 'link-2' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'no_app_identity' });
  });

  it('lit, SMS channel → no card, no link (link preview is iMessage-only)', async () => {
    lit();
    const fetchImpl = jsonFetch(202, {});
    const out = await sendLinqAppCard({
      channel: 'sms',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({
      status: 'fallback',
      why: 'not_imessage',
      link: { status: 'not_sent' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lit, unsafe fallback text → link fallback, no app part', async () => {
    lit();
    const fetchImpl = jsonFetch(202, { message: { id: 'link-3' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: { ...CARD, fallbackText: 'Saturday 10:30' },
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'unsafe_fallback_text' });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.message.parts[0].type).toBe('link');
  });

  it('lit, recipient not on iMessage (capability) → link fallback', async () => {
    lit();
    vi.stubEnv('LINQ_VOICE_MEMOS_ENABLED', 'true');
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/capability/')
        ? new Response(JSON.stringify({ available: false }), { status: 200 })
        : new Response(JSON.stringify({ message: { id: 'link-4' } }), { status: 202 }),
    );
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      recipientAddress: '+14375550101',
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'not_capable' });
  });

  it('lit, Linq refuses the card (e.g. 2018) → link fallback', async () => {
    lit();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify({ error: { code: 2018 } }), { status: 400 })
        : new Response(JSON.stringify({ message: { id: 'link-5' } }), { status: 202 });
    });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'refused', link: { status: 'sent' } });
  });
});

describe('inbound imessage_app part', () => {
  const part = {
    type: 'imessage_app',
    app: { name: 'OpenTable', team_id: 'X', bundle_id: 'y' },
    url: 'https://example.com/r/1',
    fallback_text: 'Reservation',
    layout: { caption: 'Table for 4', subcaption: 'Sat 7 PM' },
  };
  it('describes the card for the model', () => {
    expect(describeInboundAppCard(part)).toBe(
      '[iMessage app card · app: OpenTable · Table for 4 · Sat 7 PM · https://example.com/r/1]',
    );
  });
  it('drops non-https urls and empties', () => {
    expect(describeInboundAppCard({ type: 'imessage_app', url: 'http://x' })).toBeNull();
  });

  function webhook() {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'e1',
      created_at: '2026-02-05T19:31:13.736Z',
      data: {
        chat: { id: CHAT, is_group: false, owner_handle: { handle: '+12025551234', is_me: true } },
        id: 'msg-1',
        direction: 'inbound',
        sender_handle: { handle: '+12025559876', is_me: false, service: 'iMessage' },
        parts: [part],
      },
    };
  }
  const AT = new Date('2026-02-05T19:31:13.736Z');
  it('dark: stays an unnamed media part, exactly as before', () => {
    const parsed = parseLinqWebhook(webhook(), AT);
    if (parsed.kind !== 'message') throw new Error(parsed.kind);
    expect(parsed.message.text).toBe('');
    expect(parsed.message.mediaCount).toBe(1);
  });
  it('lit: read as text for the model, not media', () => {
    vi.stubEnv('LINQ_APP_CARDS_ENABLED', 'true');
    const parsed = parseLinqWebhook(webhook(), AT);
    if (parsed.kind !== 'message') throw new Error(parsed.kind);
    expect(parsed.message.text).toContain('Table for 4');
    expect(parsed.message.mediaCount).toBe(0);
  });
});
