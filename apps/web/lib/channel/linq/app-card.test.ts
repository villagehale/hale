import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCardBodyIsSafe, buildLinqAppCard, sendLinqAppCard } from './app-card';
import { describeInboundAppCard } from './app-card-inbound';
import { linqExperiencesEnabled } from './config';
import { parseLinqWebhook } from './payload';
import { clearLinqCapabilityCacheForTest } from './transport';

/** VIL-480 · Linq experience cards (link/open), dark by default, link-preview fallback. Keys unset. */

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const CARD = { url: 'https://villagehale.com/e/abc123', fallbackText: 'Story time details' };

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
  vi.stubEnv('LINQ_EXPERIENCES_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
}

function body(fetchImpl: { mock: { calls: unknown[][] } }, i = 0) {
  return JSON.parse(String((fetchImpl.mock.calls[i]?.[1] as RequestInit | undefined)?.body));
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
    'LINQ_EXPERIENCES_ENABLED',
  ]) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('flag', () => {
  it('is dark unless exactly true', () => {
    expect(linqExperiencesEnabled()).toBe(false);
    for (const v of ['on', 'false', '1', 'TRUE']) {
      vi.stubEnv('LINQ_EXPERIENCES_ENABLED', v);
      expect(linqExperiencesEnabled()).toBe(false);
    }
    vi.stubEnv('LINQ_EXPERIENCES_ENABLED', 'true\n');
    expect(linqExperiencesEnabled()).toBe(true);
  });
});

describe('fallbackText safety (transport field only)', () => {
  it.each([
    'Starts at 11:30 AM',
    'See you tomorrow',
    'Due Jan 15',
    '123 Example Ave',
    'Call 416 555 0100',
    'Saturday fun',
    'rendez-vous demain',
    '明天见',
  ])('rejects %s', (t) => expect(appCardBodyIsSafe(t)).toBe(false));
  it.each(['Event details inside', 'Tap to RSVP', 'Location inside'])('allows %s', (t) =>
    expect(appCardBodyIsSafe(t)).toBe(true),
  );
});

describe('buildLinqAppCard', () => {
  it('builds link/open with only declared params (url, title)', () => {
    expect(buildLinqAppCard(CARD)).toEqual({
      ok: true,
      experience: {
        name: 'link',
        action: 'open',
        params: { url: CARD.url, title: CARD.fallbackText },
      },
    });
    expect(buildLinqAppCard({ url: CARD.url })).toEqual({
      ok: true,
      experience: { name: 'link', action: 'open', params: { url: CARD.url } },
    });
  });
  it('refuses http, over-long title, unsafe title', () => {
    expect(buildLinqAppCard({ ...CARD, url: 'http://x.test' })).toMatchObject({ ok: false });
    expect(buildLinqAppCard({ ...CARD, fallbackText: 'x'.repeat(65) })).toEqual({
      ok: false,
      why: 'invalid_card',
    });
    expect(buildLinqAppCard({ ...CARD, fallbackText: 'Tonight at 7' })).toEqual({
      ok: false,
      why: 'unsafe_fallback_text',
    });
  });
});

describe('sendLinqAppCard', () => {
  it('dark: no experience, falls back to the link preview of the card url', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchImpl = jsonFetch(202, { message: { id: 'link-1' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'dark', link: { status: 'sent' } });
    expect(body(fetchImpl).message).toEqual({ parts: [{ type: 'link', value: CARD.url }] });
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

  it('lit: one { message: { experience } } to /chats/{id}/messages, no parts', async () => {
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
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(`/chats/${CHAT}/messages`);
    expect(body(fetchImpl)).toEqual({
      message: {
        experience: {
          name: 'link',
          action: 'open',
          params: { url: CARD.url, title: CARD.fallbackText },
        },
      },
    });
  });

  it('lit, group chat → link fallback (an experience has one recipient)', async () => {
    lit();
    const fetchImpl = jsonFetch(202, { message: { id: 'link-g' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: CARD,
      isGroup: true,
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'group_chat' });
    expect(body(fetchImpl).message.experience).toBeUndefined();
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

  it('lit, unsafe fallbackText → link fallback, no experience', async () => {
    lit();
    const fetchImpl = jsonFetch(202, { message: { id: 'link-3' } });
    const out = await sendLinqAppCard({
      channel: 'imessage',
      chatId: CHAT,
      card: { ...CARD, fallbackText: 'Saturday 10:30' },
      fetch: fetchImpl,
    });
    expect(out).toMatchObject({ status: 'fallback', why: 'unsafe_fallback_text' });
    expect(body(fetchImpl).message.parts[0].type).toBe('link');
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

  it('lit, Linq refuses the card (e.g. 2018 / unknown param 400) → link fallback', async () => {
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
    vi.stubEnv('LINQ_EXPERIENCES_ENABLED', 'true');
    const parsed = parseLinqWebhook(webhook(), AT);
    if (parsed.kind !== 'message') throw new Error(parsed.kind);
    expect(parsed.message.text).toContain('Table for 4');
    expect(parsed.message.mediaCount).toBe(0);
  });
});
