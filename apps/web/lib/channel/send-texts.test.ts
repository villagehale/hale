import { describe, expect, it } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
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
