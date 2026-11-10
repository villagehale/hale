import { describe, expect, it } from 'vitest';
import {
  WATCH_CALENDAR_TOOL_SCHEMA,
  type WatchCalendarReader,
  acceptWatchCalendarVerdict,
  createWatchCalendarCheck,
} from './calendar-check';

/**
 * The structural half of the watch calendar read. Whether an entry IS the watched
 * activity is the model's, pinned by the activity-watch-calendar-read eval and the pglite
 * journey; this pins what code does with the answer.
 */
describe('acceptWatchCalendarVerdict', () => {
  it.each(['held', 'not_held', 'unsure'] as const)('keeps %s', (verdict) => {
    expect(acceptWatchCalendarVerdict({ reason: 'r', verdict })).toBe(verdict);
  });

  it('drops a verdict outside the three', () => {
    expect(acceptWatchCalendarVerdict({ reason: 'r', verdict: 'close_it' })).toBeNull();
  });

  it('asks for the reason before the verdict', () => {
    expect(Object.keys(WATCH_CALENDAR_TOOL_SCHEMA.properties)).toEqual(['reason', 'verdict']);
    expect(WATCH_CALENDAR_TOOL_SCHEMA.required).toEqual(['reason', 'verdict']);
  });
});

describe('the check never asks about an empty calendar', () => {
  const WATCH = {
    familyId: 'fam-1',
    parentUserId: 'parent-1',
    subjectChildId: null,
    subject: 'toddler swim lessons',
    heardFacts: ['when:day:sat'],
    now: new Date('2026-12-01T15:00:00.000Z'),
  };

  function counting(): WatchCalendarReader & { calls: number } {
    const reader = {
      calls: 0,
      async read() {
        reader.calls += 1;
        return 'held' as const;
      },
    };
    return reader;
  }

  it('an empty window is its own outcome and costs no model call', async () => {
    const reader = counting();
    const check = createWatchCalendarCheck(reader, async () => ({
      status: 'read',
      today: '2026-12-01 (Tuesday)',
      calendar: [],
    }));

    expect(await check.check({} as never, WATCH)).toEqual({ outcome: 'calendar_empty' });
    expect(reader.calls).toBe(0);
  });

  it('POSITIVE CONTROL - one entry is read', async () => {
    const reader = counting();
    const check = createWatchCalendarCheck(reader, async () => ({
      status: 'read',
      today: '2026-12-01 (Tuesday)',
      calendar: [{ title: 'Swim', day: '2026-12-05 (Saturday)', start: '09:15', end: null }],
    }));

    expect(await check.check({} as never, WATCH)).toEqual({ outcome: 'on_calendar' });
    expect(reader.calls).toBe(1);
  });
});

describe('only a held verdict closes the watch', () => {
  const WATCH = {
    familyId: 'fam-1',
    parentUserId: 'parent-1',
    subjectChildId: null,
    subject: 'toddler swim lessons',
    heardFacts: ['when:day:sat'],
    now: new Date('2026-12-01T15:00:00.000Z'),
  };
  const ONE_ENTRY = async () => ({
    status: 'read' as const,
    today: '2026-12-01 (Tuesday)',
    calendar: [{ title: 'Swim', day: '2026-12-05 (Saturday)', start: '09:15', end: null }],
  });

  it.each([
    ['held', { outcome: 'on_calendar' }],
    ['not_held', { outcome: 'not_on_calendar' }],
    ['unsure', { outcome: 'calendar_unchecked', reason: 'unsure' }],
    [null, { outcome: 'calendar_unchecked', reason: 'read_failed' }],
  ] as const)('a %s verdict becomes %o', async (verdict, expected) => {
    const check = createWatchCalendarCheck({ read: async () => verdict }, ONE_ENTRY);

    expect(await check.check({} as never, WATCH)).toEqual(expected);
  });
});
