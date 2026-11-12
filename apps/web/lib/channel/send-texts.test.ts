import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { BUBBLE_GAP_MS, bubbleGaps } from './linq/bubble-gap';
import { sendTexts, textDedupeKey } from './outbound-transport';

/** VIL-467 · the shared multi-text sender. Fakes only; no provider is reached. */
describe('sendTexts', () => {
  it('sends to a person in order, awaiting each, one record per text keyed :i', async () => {
    const transport = new FakeTransport();
    const order: string[] = [];
    const rows: Array<{ index: number; key: string | null; text: string }> = [];
    const out = await sendTexts({
      texts: ['one', 'two', 'three'],
      setKey: 'set',
      target: { kind: 'person', to: '+15555550100' },
      transport,
      record: async ({ index, key, text }) => {
        order.push(`record:${index}`);
        rows.push({ index, key, text });
      },
    });
    expect(out.status).toBe('sent');
    expect(transport.bodies()).toEqual(['one', 'two', 'three']);
    expect(rows.map((r) => r.key)).toEqual(['set:0', 'set:1', 'set:2']);
    expect(order).toEqual(['record:0', 'record:1', 'record:2']);
  });

  it('awaits each send before starting the next', async () => {
    const events: string[] = [];
    await sendTexts({
      texts: ['a', 'b'],
      setKey: null,
      send: async (text) => {
        events.push(`start:${text}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${text}`);
        return text;
      },
      record: async () => {},
    });
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('checks deliverability once for the whole set, and a held set sends nothing', async () => {
    let checks = 0;
    const transport = new FakeTransport();
    const out = await sendTexts({
      texts: ['a', 'b'],
      setKey: 'k',
      target: { kind: 'person', to: '+15555550100' },
      transport,
      deliverableNow: () => {
        checks += 1;
        return false;
      },
      record: async () => {},
    });
    expect(out).toEqual({ status: 'held', reason: 'quiet_hours' });
    expect(checks).toBe(1);
    expect(transport.sent).toHaveLength(0);
  });

  it('on retry sends only the unsent texts, from the first unsent', async () => {
    const transport = new FakeTransport();
    const done = new Set([textDedupeKey('k', 0), textDedupeKey('k', 1)]);
    const out = await sendTexts({
      texts: ['a', 'b', 'c'],
      setKey: 'k',
      target: { kind: 'person', to: '+15555550100' },
      transport,
      alreadySent: async (key) => done.has(key),
      record: async () => {},
    });
    expect(transport.bodies()).toEqual(['c']);
    expect(out.status === 'sent' && out.alreadySent).toEqual([0, 1]);
  });

  it('a failure stops the set; nothing is sent in its place', async () => {
    const sent: string[] = [];
    const out = await sendTexts({
      texts: ['a', 'b', 'c'],
      setKey: 'k',
      send: async (text) => {
        if (text === 'b') throw new Error('refused');
        sent.push(text);
        return text;
      },
      record: async () => {},
    });
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.failedAt).toBe(1);
    expect(sent).toEqual(['a']);
  });

  it('rethrows a transient failure after recording what went', async () => {
    const recorded: number[] = [];
    await expect(
      sendTexts({
        texts: ['a', 'b'],
        setKey: 'k',
        send: async (text) => {
          if (text === 'b') throw new Error('timeout');
          return text;
        },
        isTransient: () => true,
        record: async ({ index }) => {
          recorded.push(index);
        },
      }),
    ).rejects.toThrow('timeout');
    expect(recorded).toEqual([0]);
  });

  it('refuses an empty set or an empty text', async () => {
    const base = { setKey: 'k', send: async (t: string) => t, record: async () => {} };
    await expect(sendTexts({ ...base, texts: [] })).rejects.toThrow(/non-empty/);
    await expect(sendTexts({ ...base, texts: ['a', '  '] })).rejects.toThrow(/non-empty/);
  });

  it('takes a group target and uses the injected send for the thread', async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const target = { kind: 'group' as const, chatId: 'chat-1', inGroup: true as const };
    await sendTexts({
      texts: ['a', 'b'],
      setKey: 'g',
      target,
      send: async (text) => {
        sent.push({ chatId: target.chatId, text });
        return text;
      },
      record: async () => {},
    });
    expect(sent).toEqual([
      { chatId: 'chat-1', text: 'a' },
      { chatId: 'chat-1', text: 'b' },
    ]);
  });
});

/** VIL-682 K5 · several bubbles of one message on iMessage land one by one, not at once. */
describe('sendTexts paced between bubbles', () => {
  const log = { info: () => {}, warn: () => {} };
  let typing: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    typing = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'POST' && String(url).endsWith('/chats/chat-1/typing')) {
          typing.push(Date.now());
        }
        return new Response(null, { status: 204 });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('three bubbles: two gaps of about two seconds, typing up before each later bubble', async () => {
    const gaps = bubbleGaps({ chatId: 'chat-1', service: 'iMessage', log });
    if (!gaps) throw new Error('an iMessage chat must be paced');
    const start = Date.now();
    const sends: Array<[number, string]> = [];
    const out = sendTexts({
      texts: ['one', 'two', 'three'],
      setKey: 'set',
      send: async (text) => {
        sends.push([Date.now(), text]);
        return text;
      },
      record: async () => {},
      pace: (send) => gaps(send),
    });
    await vi.advanceTimersByTimeAsync(2 * BUBBLE_GAP_MS);

    expect((await out).status).toBe('sent');
    expect(sends).toEqual([
      [start, 'one'],
      [start + 2_000, 'two'],
      [start + 4_000, 'three'],
    ]);
    expect(typing).toEqual([start, start + 2_000]);
  });

  it('paces only after a text this call sent, handed that text’s result', async () => {
    const paced: string[] = [];
    await sendTexts({
      texts: ['a', 'b', 'c', 'd'],
      setKey: 'k',
      // A retry: the first two went on an earlier attempt, long ago.
      alreadySent: async (key) => key === textDedupeKey('k', 0) || key === textDedupeKey('k', 1),
      send: async (text) => `sent-${text}`,
      record: async () => {},
      pace: async (send, previous) => {
        paced.push(previous);
        return send();
      },
    });
    expect(paced).toEqual(['sent-c']);
  });
});
