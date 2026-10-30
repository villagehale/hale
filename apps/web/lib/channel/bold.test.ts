import { describe, expect, it, vi } from 'vitest';
import { createSmsChannel } from '~/lib/channel/adapters/phone-sms';
import { boldDecorations, boldTextIndex } from '~/lib/channel/bold';
import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { renderReminderSms } from '~/lib/loop/templates/reminder/sms';

describe('VIL-474 · bold words the writer chose', () => {
  it('words found: one bold range over exactly those words', () => {
    const text = 'Swim moved to 4:30 at the Y today.';
    const d = boldDecorations(text, '4:30 at the Y');
    expect(d).toEqual([{ range: [14, 27], style: 'bold' }]);
    const [start, end] = d?.[0]?.range ?? [0, 0];
    expect(text.slice(start, end)).toBe('4:30 at the Y');
  });

  it('counts UTF-16 units, so an emoji or accent before the words keeps the range right', () => {
    const text = 'Été 🏊 à 16 h 30';
    const d = boldDecorations(text, '16 h 30');
    const [start, end] = d?.[0]?.range ?? [0, 0];
    expect(text.slice(start, end)).toBe('16 h 30');
  });

  it('words missing: nothing to decorate, the text is left as written', () => {
    expect(boldDecorations('Swim is at 4:30.', '5:00')).toBeUndefined();
    expect(boldTextIndex(['Swim is at 4:30.'], '5:00')).toBe(-1);
  });

  it('no bold returned: nothing to decorate', () => {
    expect(boldDecorations('Swim is at 4:30.', null)).toBeUndefined();
    expect(boldDecorations('Swim is at 4:30.', undefined)).toBeUndefined();
    expect(boldDecorations('Swim is at 4:30.', '   ')).toBeUndefined();
  });

  it('at most one: only the first text holding the words', () => {
    expect(boldTextIndex(['Swim at the Y.', 'Moved to 4:30.', 'Still 4:30.'], '4:30')).toBe(1);
  });
});

describe('VIL-474 · the reminder leg on the wire', () => {
  function channel(transport: ChannelTransport) {
    return createSmsChannel({
      transport,
      configured: true,
      resolveTarget: async () => '+15550001111',
    } as never);
  }

  it('the renderer carries bold, and the sent body is the writer’s words byte for byte', async () => {
    const sent: OutboundMessage[] = [];
    const transport: ChannelTransport = {
      send: vi.fn(async (m: OutboundMessage) => {
        sent.push(m);
        return { providerMessageId: 'p1' };
      }),
    };
    const rendered = renderReminderSms({
      offset: '-PT1H',
      timeZone: 'America/Toronto',
      events: [],
      children: [],
      deepLink: null,
      unsubscribeUrl: null,
      texts: ['Swim moved to 4:30 today.'],
      bold: '4:30',
    });
    expect(rendered.bold).toBe('4:30');
    await channel(transport).send({
      userId: 'u1',
      rendered: { kind: 'sms', text: 'Swim moved to 4:30 today.', bold: '4:30' },
    });
    expect(sent[0]?.body).toBe('Swim moved to 4:30 today.');
    expect(sent[0]?.decorations).toEqual([{ range: [14, 18], style: 'bold' }]);
  });

  it('SMS gets plain text: no markers in the body, and no decoration when none was chosen or found', async () => {
    const sent: OutboundMessage[] = [];
    const transport: ChannelTransport = {
      send: async (m) => {
        sent.push(m);
        return { providerMessageId: 'p' };
      },
    };
    const sms = channel(transport);
    await sms.send({ userId: 'u1', rendered: { kind: 'sms', text: 'Swim is at 4:30.' } });
    await sms.send({
      userId: 'u1',
      rendered: { kind: 'sms', text: 'Swim is at 4:30.', bold: 'not in the text' },
    });
    for (const m of sent) {
      expect(m.body).toBe('Swim is at 4:30.');
      expect(m.body).not.toMatch(/[*_]/);
      expect(m).not.toHaveProperty('decorations');
    }
  });
});
