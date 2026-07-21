import { describe, expect, it } from 'vitest';
import {
  type EventSnapshot,
  type FiringReminder,
  type ScheduledReminder,
  batchReminders,
  classifyReminder,
  expectedReminders,
  offsetUrgency,
  reminderFireAt,
} from './schedule';

/**
 * VIL-223 · D1 — the pure scheduling core. Every expectation is derived from the spec
 * (the offset definitions, the family-local evening slot, the don't-send matrix), never
 * copied from output. Toronto anchors the DST cases: EST = UTC−5 (winter), EDT = UTC−4
 * (summer); 2026 springs forward Mar 8, falls back Nov 1.
 */

const TZ = 'America/Toronto';

// 2026-07-25 10:00 Toronto (EDT −4) = 14:00Z.
const SUMMER_START = new Date('2026-07-25T14:00:00Z');

function reminder(over: Partial<ScheduledReminder> = {}): ScheduledReminder {
  return { eventRef: 'e1', offset: '-PT1H', fireAt: new Date('2026-07-25T13:00:00Z'), ...over };
}
function event(over: Partial<EventSnapshot> = {}): EventSnapshot {
  return { id: 'e1', startsAt: SUMMER_START, deletedAt: null, ...over };
}

describe('reminderFireAt — the two offsets, family-local', () => {
  it('T-1h is exactly one hour before the start instant', () => {
    expect(reminderFireAt(SUMMER_START, '-PT1H', TZ).toISOString()).toBe('2026-07-25T13:00:00.000Z');
  });

  it('T-24h is 18:00 local the day BEFORE the event day (summer EDT)', () => {
    // 18:00 on 2026-07-24 EDT = 22:00Z.
    expect(reminderFireAt(SUMMER_START, '-P1D', TZ).toISOString()).toBe('2026-07-24T22:00:00.000Z');
  });

  it('T-24h shifts with the winter offset (EST −5)', () => {
    // 2026-01-15 10:00 EST = 15:00Z; 18:00 on 01-14 EST = 23:00Z.
    const winter = new Date('2026-01-15T15:00:00Z');
    expect(reminderFireAt(winter, '-P1D', TZ).toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('is DST-correct on a spring-forward day (18:00 is clear of the 02:00 gap)', () => {
    // Event 2026-03-09 10:00 EDT = 14:00Z; day before is the transition day 03-08.
    // 18:00 on 03-08 is post-transition EDT (−4) = 22:00Z, NOT the midnight-offset 23:00Z.
    const afterSpring = new Date('2026-03-09T14:00:00Z');
    expect(reminderFireAt(afterSpring, '-P1D', TZ).toISOString()).toBe('2026-03-08T22:00:00.000Z');
  });

  it('T-1h crosses midnight for an after-midnight event', () => {
    // 2026-07-25 00:30 Toronto = 04:30Z; minus 1h = 03:30Z (= 23:30 on the 24th local).
    const afterMidnight = new Date('2026-07-25T04:30:00Z');
    expect(reminderFireAt(afterMidnight, '-PT1H', TZ).toISOString()).toBe(
      '2026-07-25T03:30:00.000Z',
    );
  });
});

describe('offsetUrgency — T-1h is time-sensitive, T-24h is normal', () => {
  it('maps each offset to its A2 urgency', () => {
    expect(offsetUrgency('-PT1H')).toBe('time_sensitive');
    expect(offsetUrgency('-P1D')).toBe('normal');
  });
});

describe('classifyReminder — the don\'t-send matrix (the trust test)', () => {
  const DUE = new Date('2026-07-25T13:00:00Z'); // T-1h fire moment for SUMMER_START

  it('fires a due reminder for a live, not-yet-started event', () => {
    expect(classifyReminder(reminder(), event(), DUE, TZ)).toEqual({ action: 'fire' });
  });

  it('NEVER fires for a soft-deleted event — cancel', () => {
    const deleted = event({ deletedAt: new Date('2026-07-24T09:00:00Z') });
    expect(classifyReminder(reminder(), deleted, DUE, TZ)).toEqual({ action: 'cancel' });
  });

  it('NEVER fires for an event that no longer exists — cancel', () => {
    expect(classifyReminder(reminder(), null, DUE, TZ)).toEqual({ action: 'cancel' });
  });

  it('is stale when the event moved (its computed fire_at no longer matches the row)', () => {
    const moved = event({ startsAt: new Date('2026-07-26T14:00:00Z') });
    expect(classifyReminder(reminder(), moved, DUE, TZ)).toEqual({ action: 'stale' });
  });

  it('suppresses (started) when the event already began', () => {
    // startsAt == now → T-1h fire_at = startsAt−1h (consistent, not stale), event started.
    const started = event({ startsAt: new Date('2026-07-25T13:00:00Z') });
    const r = reminder({ fireAt: new Date('2026-07-25T12:00:00Z') });
    const now = new Date('2026-07-25T13:00:00Z');
    expect(classifyReminder(r, started, now, TZ)).toEqual({ action: 'suppress', reason: 'started' });
  });

  it('waits when the fire moment is still in the future', () => {
    const early = new Date('2026-07-25T12:00:00Z');
    expect(classifyReminder(reminder(), event(), early, TZ)).toEqual({ action: 'wait' });
  });

  it('suppresses (missed) a slot more than the grace behind now', () => {
    // T-24h fire_at 2026-07-24T22:00Z; now 4h later; event not started → missed, not fired late.
    const r = reminder({ offset: '-P1D', fireAt: new Date('2026-07-24T22:00:00Z') });
    const now = new Date('2026-07-25T02:00:00Z');
    expect(classifyReminder(r, event(), now, TZ)).toEqual({ action: 'suppress', reason: 'missed' });
  });

  it('suppresses (interacted) when the parent just engaged the event in-channel', () => {
    expect(classifyReminder(reminder(), event(), DUE, TZ, { recentInteraction: true })).toEqual({
      action: 'suppress',
      reason: 'interacted',
    });
  });
});

describe('expectedReminders — what a live event should have', () => {
  it('one row per offset with the computed fire_at, in offset order', () => {
    expect(expectedReminders(event(), TZ)).toEqual([
      { eventRef: 'e1', offset: '-P1D', fireAt: new Date('2026-07-24T22:00:00Z') },
      { eventRef: 'e1', offset: '-PT1H', fireAt: new Date('2026-07-25T13:00:00Z') },
    ]);
  });

  it('a soft-deleted event should have none', () => {
    expect(expectedReminders(event({ deletedAt: new Date() }), TZ)).toEqual([]);
  });
});

describe('batchReminders — same-evening T-24h merge into one message (rule #4)', () => {
  const eve = new Date('2026-07-24T22:00:00Z'); // 18:00 EDT on 07-24
  const firing = (over: Partial<FiringReminder>): FiringReminder => ({
    eventRef: 'e1', parentUserId: 'p1', offset: '-P1D', fireAt: eve, ...over,
  });

  it('merges a parent\'s same-evening T-24h reminders into one batch', () => {
    const batches = batchReminders([firing({ eventRef: 'e1' }), firing({ eventRef: 'e2' })], TZ);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      parentUserId: 'p1',
      offset: '-P1D',
      eveningKey: '2026-07-24',
      eventRefs: ['e1', 'e2'],
    });
  });

  it('never merges T-1h reminders — each fires on its own', () => {
    const t1h = (ref: string): FiringReminder => ({
      eventRef: ref, parentUserId: 'p1', offset: '-PT1H', fireAt: new Date('2026-07-25T13:00:00Z'),
    });
    expect(batchReminders([t1h('e1'), t1h('e2')], TZ)).toHaveLength(2);
  });

  it('keeps different parents in separate batches', () => {
    const batches = batchReminders(
      [firing({ parentUserId: 'p1' }), firing({ parentUserId: 'p2' })],
      TZ,
    );
    expect(batches).toHaveLength(2);
  });
});
