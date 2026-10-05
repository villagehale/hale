import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { makeFakeDb } from './fakes';
import { DEFAULT_SCHEDULE_WEEKS, MAX_SCHEDULE_WEEKS } from './onboarding-turn';
import { writeScheduleAdds } from './schedule-adds';

/**
 * Step 9 of onboarding: the adds the model settled in conversation become
 * family events, as reminders. Nothing here registers anyone.
 */

const FAMILY = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const LINES = ['Swim (ages 3-5) - Saturdays 9:15am - $12', 'Fall fair - Sunday', 'Story time'];

function audits(fake: ReturnType<typeof makeFakeDb>) {
  return fake.writes.filter(
    (write) =>
      write.op === 'insert' &&
      write.table === schema.auditLog &&
      write.payload.actionTaken === 'onboarding_schedule_added',
  );
}

describe('writeScheduleAdds', () => {
  it('writes a weekly add as one event per week, titled off the find line, and audits it once', async () => {
    const fake = makeFakeDb();
    const written = await writeScheduleAdds(fake.db, {
      familyId: FAMILY,
      userId: USER,
      sessionId: SESSION,
      adds: [{ line: 1, cadence: 'weekly', date: '2026-10-10', time: '09:15', weeks: 3 }],
      lines: LINES,
      already: [],
    });
    const events = fake.rows(schema.familyEvents);
    expect(events).toHaveLength(3);
    expect(events.every((row) => row.title === 'Swim')).toBe(true);
    expect(events.every((row) => row.source === 'channel' && row.createdBy === USER)).toBe(true);
    const starts = events.map((row) => new Date(row.startsAt).toISOString());
    expect(starts).toEqual([
      '2026-10-10T13:15:00.000Z',
      '2026-10-17T13:15:00.000Z',
      '2026-10-24T13:15:00.000Z',
    ]);
    expect(written.eventIds).toHaveLength(3);
    expect(written.scheduled).toEqual([
      { line: 1, title: 'Swim', cadence: 'weekly', date: '2026-10-10', time: '09:15' },
    ]);
    const trail = audits(fake);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.payload.after).toMatchObject({ line: 1, weeks: 3, kind: 'reminder' });
  });

  it('writes a one-off with no time as an all-day event', async () => {
    const fake = makeFakeDb();
    await writeScheduleAdds(fake.db, {
      familyId: FAMILY,
      userId: USER,
      sessionId: SESSION,
      adds: [{ line: 2, cadence: 'once', date: '2026-10-11', time: null, weeks: null }],
      lines: LINES,
      already: [],
    });
    const [event] = fake.rows(schema.familyEvents);
    expect(event?.title).toBe('Fall fair');
    expect(new Date(event?.startsAt ?? 0).toISOString()).toBe('2026-10-11T04:00:00.000Z');
    expect(new Date(event?.endsAt ?? 0).toISOString()).toBe('2026-10-12T04:00:00.000Z');
  });

  it('defaults a weekly add to eight weeks and caps it at twelve', async () => {
    const fake = makeFakeDb();
    await writeScheduleAdds(fake.db, {
      familyId: FAMILY,
      userId: USER,
      sessionId: SESSION,
      adds: [
        { line: 1, cadence: 'weekly', date: '2026-10-10', time: null, weeks: null },
        { line: 3, cadence: 'weekly', date: '2026-10-13', time: null, weeks: 40 },
      ],
      lines: LINES,
      already: [],
    });
    const events = fake.rows(schema.familyEvents);
    expect(events.filter((row) => row.title === 'Swim')).toHaveLength(DEFAULT_SCHEDULE_WEEKS);
    expect(events.filter((row) => row.title === 'Story time')).toHaveLength(MAX_SCHEDULE_WEEKS);
  });

  it('skips a line that is not on the map and an add already written on that date', async () => {
    const fake = makeFakeDb();
    const written = await writeScheduleAdds(fake.db, {
      familyId: FAMILY,
      userId: USER,
      sessionId: SESSION,
      adds: [
        { line: 9, cadence: 'once', date: '2026-10-11', time: null, weeks: null },
        { line: 2, cadence: 'once', date: '2026-10-11', time: null, weeks: null },
        { line: 2, cadence: 'once', date: '2026-10-11', time: null, weeks: null },
        { line: 3, cadence: 'once', date: '2026-10-13', time: null, weeks: null },
      ],
      lines: LINES,
      already: [{ line: 2, title: 'Fall fair', cadence: 'once', date: '2026-10-11', time: null }],
    });
    expect(fake.rows(schema.familyEvents).map((row) => row.title)).toEqual(['Story time']);
    expect(written.scheduled.map((row) => row.line)).toEqual([3]);
    expect(audits(fake)).toHaveLength(1);
  });

  it('writes nothing and audits nothing for no adds', async () => {
    const fake = makeFakeDb();
    const written = await writeScheduleAdds(fake.db, {
      familyId: FAMILY,
      userId: USER,
      sessionId: SESSION,
      adds: [],
      lines: LINES,
      already: [],
    });
    expect(written).toEqual({ scheduled: [], eventIds: [] });
    expect(fake.rows(schema.familyEvents)).toEqual([]);
    expect(audits(fake)).toEqual([]);
  });
});
