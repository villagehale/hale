import { describe, expect, it, vi } from 'vitest';
import {
  type FamilyAvailability,
  commonTimeFacts,
  composeCommonTime,
  familiesToAsk,
  findCommonTimes,
} from './common-time';
import { type BusyBlock, freeBusyOnly } from './household-calendar';

// Mon Oct 26 2026, 9:00 Toronto (13:00Z).
const NOW = new Date('2026-10-26T13:00:00.000Z');
const at = (iso: string) => new Date(iso);
const span = (s: string, e: string) => ({ start: at(s), end: at(e) });

function block(over: Partial<BusyBlock>): BusyBlock {
  return {
    integrationId: 'i',
    userId: 'u',
    eventId: 'e',
    start: null,
    end: null,
    allDay: false,
    kidRelated: false,
    title: 'Hartley Family Law consult',
    status: 'confirmed',
    announced: false,
    followupSent: false,
    recurringEventId: null,
    ...over,
  };
}

const chens: FamilyAvailability = {
  label: 'the Chens',
  timeZone: 'America/Toronto',
  busy: [span('2026-10-26T13:00:00Z', '2026-10-26T22:00:00Z')],
};
const patels: FamilyAvailability = {
  label: 'the Patels',
  timeZone: 'America/Toronto',
  busy: [span('2026-10-27T12:00:00Z', '2026-10-27T20:00:00Z')],
};
const ruiz: FamilyAvailability = {
  label: 'the Ruiz family',
  timeZone: 'America/Toronto',
  busy: null,
};

const overlaps = (slot: Date, s: { start: Date; end: Date }) =>
  slot.getTime() < s.end.getTime() && s.start.getTime() < slot.getTime() + 3_600_000;

describe('freeBusyOnly', () => {
  it('keeps only time spans: no title, place or id survives', () => {
    const out = freeBusyOnly([
      block({ start: at('2026-10-27T18:00:00Z'), end: at('2026-10-27T19:00:00Z') }),
      block({ start: at('2026-10-28T18:00:00Z'), status: 'cancelled' }),
      block({ start: at('2026-10-29T18:00:00Z') }),
    ]);
    expect(out).toEqual([
      span('2026-10-27T18:00:00Z', '2026-10-27T19:00:00Z'),
      span('2026-10-29T18:00:00Z', '2026-10-29T19:00:00Z'),
    ]);
    expect(JSON.stringify(out)).not.toContain('Hartley');
  });
});

describe('findCommonTimes', () => {
  it('three families, one without a calendar: avoids every busy span and chat-ruled-out time', () => {
    const blocked = [span('2026-10-26T22:00:00Z', '2026-10-27T01:00:00Z')]; // "tonight is out"
    const slots = findCommonTimes({ families: [chens, patels, ruiz], blocked, now: NOW });
    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      for (const f of [chens, patels])
        for (const s of f.busy ?? []) expect(overlaps(slot, s)).toBe(false);
      for (const s of blocked) expect(overlaps(slot, s)).toBe(false);
    }
    expect(familiesToAsk([chens, patels, ruiz])).toEqual(['the Ruiz family']);
  });

  it("respects each family's time zone and quiet hours", () => {
    const vancouver: FamilyAvailability = {
      label: 'the Lees',
      timeZone: 'America/Vancouver',
      busy: [],
    };
    const toronto: FamilyAvailability = {
      label: 'the Chens',
      timeZone: 'America/Toronto',
      busy: [],
    };
    const slots = findCommonTimes({ families: [toronto, vancouver], now: NOW });
    expect(slots.length).toBeGreaterThan(0);
    const hour = (d: Date, tz: string) =>
      Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(d),
      );
    for (const slot of slots) {
      expect(hour(slot, 'America/Vancouver')).toBeGreaterThanOrEqual(8);
      expect(hour(slot, 'America/Toronto')).toBeLessThanOrEqual(20);
    }
    const late = findCommonTimes({
      families: [{ ...toronto, quietEndHour: 10 }, vancouver],
      now: NOW,
    });
    for (const slot of late) expect(hour(slot, 'America/Toronto')).toBeGreaterThanOrEqual(11);
  });

  it('caps at three and spreads one per day', () => {
    const slots = findCommonTimes({ families: [ruiz], now: NOW, count: 9 });
    expect(slots).toHaveLength(3);
    const days = slots.map((s) => s.toISOString().slice(0, 10));
    expect(new Set(days).size).toBe(3);
  });

  it('returns nothing when no time works', () => {
    const always = { ...chens, busy: [span('2026-10-26T00:00:00Z', '2026-11-03T00:00:00Z')] };
    expect(findCommonTimes({ families: [always, patels], now: NOW })).toEqual([]);
  });
});

describe('commonTimeFacts', () => {
  it('carries labels and times only, in every family zone when zones differ', () => {
    const input = {
      families: [chens, { ...ruiz, timeZone: 'America/Vancouver' }],
      now: NOW,
    };
    const facts = commonTimeFacts(input, [at('2026-10-27T22:00:00Z')], 'fr');
    expect(Object.keys(facts).sort()).toEqual(
      ['askFamilies', 'checkedFamilies', 'option1', 'proposalCount'].sort(),
    );
    expect(facts.option1).toContain('America/Vancouver');
    expect(facts.askFamilies).toBe('the Ruiz family');
  });
});

describe('composeCommonTime', () => {
  it('the AI writes the line from facts, with the language passed through', async () => {
    const write = vi.fn(async () => 'written by the model');
    const out = await composeCommonTime({ families: [chens, patels, ruiz], now: NOW }, 'ja', write);
    expect(out?.text).toBe('written by the model');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'group_common_time', language: 'ja' }),
    );
  });

  it('sends nothing when the AI fails: no fallback line', async () => {
    const out = await composeCommonTime(
      { families: [chens, patels], now: NOW },
      'es',
      async () => null,
    );
    expect(out).toBeNull();
  });

  it('sends nothing when no time works and nobody can be asked', async () => {
    const write = vi.fn(async () => 'x');
    const always = { ...chens, busy: [span('2026-10-26T00:00:00Z', '2026-11-03T00:00:00Z')] };
    expect(
      await composeCommonTime({ families: [always, patels], now: NOW }, 'en', write),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('never hands the writer a calendar title', async () => {
    const write = vi.fn(async () => 'ok');
    const busy = freeBusyOnly([
      block({ start: at('2026-10-27T18:00:00Z'), end: at('2026-10-27T19:00:00Z') }),
    ]);
    await composeCommonTime({ families: [{ ...chens, busy }, ruiz], now: NOW }, 'zh', write);
    expect(JSON.stringify(write.mock.calls)).not.toContain('Hartley');
  });
});
