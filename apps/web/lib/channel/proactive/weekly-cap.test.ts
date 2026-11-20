import { describe, expect, it } from 'vitest';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';
import { at } from '~/lib/testing/clock';
import { PROACTIVE_ROUTING } from './flag';
import {
  PROACTIVE_WEEKLY_CAP_SENDS_ENV,
  WEEKLY_CAP_CLASS,
  WEEKLY_CAP_COUNTED_KINDS,
  WEEKLY_CAP_WINDOW_MS,
  countsTowardWeeklyCap,
  weeklyCapSetting,
  weeklyCapVerdict,
} from './weekly-cap';

/**
 * VIL-722 · the pure half of the weekly proactive cap: the number it reads, which classes
 * spend the budget, and when a full week reopens. The review's use of it runs over real
 * Postgres in weekly-cap.pglite.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;
const T1 = at('2026-11-16T15:00:00.000Z');
const T2 = at('2026-11-17T15:00:00.000Z');
const T3 = at('2026-11-18T15:00:00.000Z');

describe('the weekly cap number', () => {
  it('has no number unless one is set: unset caps nothing', () => {
    expect(weeklyCapSetting({})).toEqual({ limit: null, reason: 'unset' });
  });

  it('reads a positive whole number', () => {
    expect(weeklyCapSetting({ [PROACTIVE_WEEKLY_CAP_SENDS_ENV]: '2' })).toEqual({ limit: 2 });
    expect(weeklyCapSetting({ [PROACTIVE_WEEKLY_CAP_SENDS_ENV]: '12' })).toEqual({ limit: 12 });
  });

  it('reads a number with a trailing newline the way the other config numbers do', () => {
    expect(weeklyCapSetting({ [PROACTIVE_WEEKLY_CAP_SENDS_ENV]: '2\n' })).toEqual({ limit: 2 });
  });

  it('names anything else invalid, and an invalid number caps nothing', () => {
    for (const raw of ['', ' ', '0', '-2', '2.5', 'two', 'true', 'NaN', 'Infinity']) {
      expect({ raw, setting: weeklyCapSetting({ [PROACTIVE_WEEKLY_CAP_SENDS_ENV]: raw }) }).toEqual(
        { raw, setting: { limit: null, reason: 'invalid' } },
      );
    }
  });
});

describe('which classes spend the weekly budget', () => {
  const exempt = (Object.keys(WEEKLY_CAP_CLASS) as ProactiveSendKind[])
    .filter((kind) => WEEKLY_CAP_CLASS[kind] === 'exempt')
    .sort();

  it('exempts what the parent asked for or is owed, and nothing else', () => {
    expect(exempt).toEqual(
      [
        'activity_followup',
        'autonomy_acted',
        'autonomy_armed',
        'registration_sequence',
        'spot_open',
        'spot_open_instant',
      ].sort(),
    );
  });

  it('counts everything Hale says on its own', () => {
    for (const kind of [
      'nudge',
      'village_intro',
      'followup',
      'plan_check_in',
      'email_alert',
      'calendar_alert',
      'evening_check_in',
      'mid_activity_ask',
      'next_day_checkback',
      'registration_opening',
      'school_break_ask',
      'co_parent_departed',
      'travel_brief',
      'duty_ask',
    ] as const) {
      expect({ kind, counted: WEEKLY_CAP_COUNTED_KINDS.includes(kind) }).toEqual({
        kind,
        counted: true,
      });
    }
  });

  it('lists every class the router knows, so a new class has to choose', () => {
    expect(Object.keys(WEEKLY_CAP_CLASS).sort()).toEqual(Object.keys(PROACTIVE_ROUTING).sort());
  });

  it('exempts every class that sends on its own clock and never reaches the decider', () => {
    const immediate = (Object.keys(PROACTIVE_ROUTING) as ProactiveSendKind[]).filter(
      (kind) => PROACTIVE_ROUTING[kind] === 'immediate',
    );
    expect(immediate.length).toBeGreaterThan(0);
    for (const kind of immediate) expect({ kind, cap: WEEKLY_CAP_CLASS[kind] }).toEqual({
      kind,
      cap: 'exempt',
    });
  });

  it('exempts an item the parent asked for, whatever its class', () => {
    expect(countsTowardWeeklyCap({ kind: 'nudge', parentRequested: false })).toBe(true);
    expect(countsTowardWeeklyCap({ kind: 'nudge', parentRequested: true })).toBe(false);
    expect(countsTowardWeeklyCap({ kind: 'spot_open', parentRequested: false })).toBe(false);
  });
});

describe('the weekly verdict', () => {
  it('is under while the window holds fewer sends than the number', () => {
    expect(weeklyCapVerdict([], 2)).toEqual({ over: false, spent: 0 });
    expect(weeklyCapVerdict([T1], 2)).toEqual({ over: false, spent: 1 });
  });

  it('is over at the number, and reopens when the oldest send turns seven days old', () => {
    expect(weeklyCapVerdict([T1, T2], 2)).toEqual({
      over: true,
      spent: 2,
      reopensAt: new Date(T1.getTime() + 7 * DAY),
    });
    expect(WEEKLY_CAP_WINDOW_MS).toBe(7 * DAY);
  });

  it('past the number, reopens only once enough sends have aged out to leave room for one', () => {
    // Three in the window against two: the first and the second must both age out.
    expect(weeklyCapVerdict([T3, T1, T2], 2)).toEqual({
      over: true,
      spent: 3,
      reopensAt: new Date(T2.getTime() + 7 * DAY),
    });
  });

  it('refuses a number that is not a positive whole number', () => {
    expect(() => weeklyCapVerdict([T1], 0)).toThrow(RangeError);
    expect(() => weeklyCapVerdict([T1], 1.5)).toThrow(RangeError);
  });
});
