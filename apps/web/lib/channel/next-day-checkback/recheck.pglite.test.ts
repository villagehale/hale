import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type WatchCalendarInput,
  type WatchCalendarReader,
  type WatchCalendarVerdict,
  createWatchCalendarCheck,
} from '~/lib/channel/activity/calendar-check';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { nextDayCheckbackDedupeKey } from './claim';
import { NEXT_DAY_CHECKBACK_ENABLED_ENV } from './flag';
import { createRecheckOpenAsk, defaultRecheckOpenAsk, loadCheckbackCalendar } from './recheck';

/**
 * The send-time re-check, against real Postgres. The calendar reader is a port: its
 * judgment is graded on real cached Claude in the activity-watch-calendar-read eval
 * (the `checkback-*` fixtures). What this file owns is what reaches the reader and
 * what each answer does to the one check-back.
 */

const ET = 'America/New_York';
const ANCHOR = new Date('2026-11-11T03:40:00.000Z');
/** Wednesday 10:23 EST: the review that would send it. */
const NOW = new Date('2026-11-11T15:23:00.000Z');
const TITLE = 'Fall swim lessons for the 4 year old';

let db: TestDb;
let familyId: string;
let primaryId: string;
let coParentId: string;
let childId: string;
let teenName: string;
let askId: string;
let workstreamId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'true');
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  const [primary, co] = await db.database
    .insert(schema.users)
    .values([
      { name: 'Primary', timezone: ET },
      { name: 'Second', timezone: ET },
    ])
    .returning({ id: schema.users.id });
  primaryId = primary?.id as string;
  coParentId = co?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryId, role: 'primary_parent' },
    { familyId, userId: coParentId, role: 'co_parent' },
  ]);
  teenName = 'Morgan';
  const [child] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Robin', dateOfBirth: '2022-06-01' },
      { familyId, name: teenName, dateOfBirth: '2011-02-01' },
    ])
    .returning({ id: schema.children.id });
  childId = child?.id as string;
  const [ask] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: coParentId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'swim this fall?',
      createdAt: new Date(ANCHOR.getTime() - 60_000),
    })
    .returning({ id: schema.channelMessages.id });
  askId = ask?.id as string;
  const [row] = await db.database
    .insert(schema.familyWorkstreams)
    .values({
      familyId,
      title: TITLE,
      status: 'waiting_on_parent',
      nextStep: 'Pick a session',
      childIds: [childId],
      createdFrom: askId,
      updatedFrom: askId,
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
      expiresAt: new Date(ANCHOR.getTime() + 14 * 86_400_000),
    })
    .returning({ id: schema.familyWorkstreams.id });
  workstreamId = row?.id as string;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

function reader(verdict: WatchCalendarVerdict | null): {
  reader: WatchCalendarReader;
  calls: WatchCalendarInput[];
} {
  const calls: WatchCalendarInput[] = [];
  return {
    calls,
    reader: {
      read: async (input) => {
        calls.push(input);
        return verdict;
      },
    },
  };
}

function recheckWith(verdict: WatchCalendarVerdict | null) {
  const spy = reader(verdict);
  const recheck = createRecheckOpenAsk(createWatchCalendarCheck(spy.reader, loadCheckbackCalendar));
  return { spy, recheck };
}

function item(over: { payload?: Record<string, unknown> | null } = {}) {
  return {
    familyId,
    parentUserId: coParentId,
    dedupeKey: nextDayCheckbackDedupeKey(workstreamId),
    payload:
      over.payload === undefined
        ? {
            nextDayCheckback: {
              workstreamId,
              anchorAt: ANCHOR.toISOString(),
              subjectChildId: childId,
            },
          }
        : over.payload,
    now: NOW,
  };
}

async function booking(parentUserId: string, title: string, over: { eventId?: string } = {}) {
  await db.database.insert(schema.activityBookings).values({
    familyId,
    parentUserId,
    integrationId: '00000000-0000-4000-8000-000000000001',
    messageId: `m-${title}`,
    providerHost: 'rec.example.test',
    title,
    firstSessionAt: new Date('2026-11-21T15:00:00.000Z'),
    eventId: over.eventId ?? null,
  });
}

describe('createRecheckOpenAsk', () => {
  it('closes the ask by name once the lane flag is off, and owes it while on', async () => {
    const { recheck } = recheckWith('not_held');
    vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'false');
    expect(await recheck(db.database, item())).toEqual({ verdict: 'closed', reason: 'lane_off' });
    vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'true');
    expect(await recheck(db.database, item())).toEqual({ verdict: 'owed', timeZone: ET });
  });

  it('closes an ask that moved, closed, or was followed up since it was queued', async () => {
    const { recheck } = recheckWith('not_held');
    const ws = schema.familyWorkstreams;
    await db.database
      .update(ws)
      .set({ updatedAt: new Date(ANCHOR.getTime() + 3_600_000) })
      .where(eq(ws.id, workstreamId));
    expect(await recheck(db.database, item())).toEqual({ verdict: 'closed', reason: 'ask_moved' });

    await db.database
      .update(ws)
      .set({ updatedAt: ANCHOR, status: 'done', closedAt: ANCHOR })
      .where(eq(ws.id, workstreamId));
    expect(await recheck(db.database, item())).toEqual({ verdict: 'closed', reason: 'ask_moved' });

    await db.database
      .update(ws)
      .set({ status: 'waiting_on_parent', closedAt: null, lastFollowedUpAt: ANCHOR })
      .where(eq(ws.id, workstreamId));
    expect(await recheck(db.database, item())).toEqual({ verdict: 'closed', reason: 'ask_moved' });
  });

  it('closes an ask whose parent texted after it', async () => {
    const { recheck } = recheckWith('not_held');
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: coParentId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'ok',
      createdAt: new Date(ANCHOR.getTime() + 600_000),
    });
    expect(await recheck(db.database, item())).toEqual({
      verdict: 'closed',
      reason: 'parent_returned',
    });
  });

  it('owes the ask without a model call when nothing is on the calendar', async () => {
    const { recheck, spy } = recheckWith('held');
    expect(await recheck(db.database, item())).toEqual({ verdict: 'owed', timeZone: ET });
    expect(spy.calls).toHaveLength(0);
  });

  it("reads the asker's own unplaced bookings, never the other parent's or a teen's", async () => {
    await booking(coParentId, 'Aquatics Level 2 - Session 1');
    await booking(coParentId, 'Already placed swim', {
      eventId: '00000000-0000-4000-8000-000000000002',
    });
    await booking(primaryId, 'Gymnastics with the other parent');
    await booking(coParentId, `${teenName} driving lesson`);
    const { recheck, spy } = recheckWith('held');

    expect(await recheck(db.database, item())).toEqual({
      verdict: 'closed',
      reason: 'finished_elsewhere',
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.watching).toBe(TITLE);
    expect(spy.calls[0]?.calendar.map((entry) => entry.title)).toEqual([
      'Aquatics Level 2 - Session 1',
    ]);
    expect(spy.calls[0]?.calendar[0]).toMatchObject({
      day: '2026-11-21 (Saturday)',
      start: '10:00',
    });
  });

  it('drops a maybe, keeps a no, and holds a failed read', async () => {
    await booking(coParentId, 'Aquatics Level 2 - Session 1');
    expect(await recheckWith('unsure').recheck(db.database, item())).toEqual({
      verdict: 'closed',
      reason: 'maybe_finished',
    });
    expect(await recheckWith('not_held').recheck(db.database, item())).toEqual({
      verdict: 'owed',
      timeZone: ET,
    });
    expect(await recheckWith(null).recheck(db.database, item())).toEqual({
      verdict: 'unchecked',
      reason: 'recheck_failed',
    });
  });

  it("owes the ask on the asker's own clock, else the household's, and holds it on neither", async () => {
    const { recheck } = recheckWith('not_held');
    const LA = 'America/Los_Angeles';
    const zone = (userId: string, timezone: string) =>
      db.database.update(schema.users).set({ timezone }).where(eq(schema.users.id, userId));

    await zone(coParentId, LA);
    expect(await recheck(db.database, item())).toEqual({ verdict: 'owed', timeZone: LA });

    // The UTC column default means the asker never set one: the household's clock.
    await zone(coParentId, 'UTC');
    expect(await recheck(db.database, item())).toEqual({ verdict: 'owed', timeZone: ET });

    await zone(primaryId, 'UTC');
    expect(await recheck(db.database, item())).toEqual({
      verdict: 'unchecked',
      reason: 'zone_unknown',
    });
  });

  it('throws on a check-back with no workstream payload: a code bug, not a state', async () => {
    const { recheck } = recheckWith('not_held');
    await expect(recheck(db.database, item({ payload: null }))).rejects.toThrow(/payload/);
  });

  it('is wired in production through the booking-aware calendar', async () => {
    // No key: the production reader fails closed. With only the household calendar
    // (empty here) it would never be asked and the ask would be owed, so a held
    // check-back proves the asker's booking reached the default reader.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await booking(coParentId, 'Aquatics Level 2 - Session 1');
    expect(await defaultRecheckOpenAsk()(db.database, item())).toEqual({
      verdict: 'unchecked',
      reason: 'recheck_failed',
    });
  });
});
