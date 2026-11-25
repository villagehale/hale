import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { PRIVATE_EVENT_WHAT, channelScheduleReader } from './tools';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. The coach's connected-week read hands the model no calendar title
 * or booking a 13+ child with no name could own.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
const NOW = new Date('2026-09-27T15:00:00.000Z');
const START = new Date('2026-09-28T04:00:00.000Z');
const END = new Date('2026-10-05T04:00:00.000Z');
const DAY_KEYS = [
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
];

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function connectedWeek(
  children: ReadonlyArray<{ name: string | null; years: number }>,
  titles: readonly string[],
) {
  const family = await seedFamily(db.database, 'Coach household');
  for (const child of children) {
    const born = new Date(NOW);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId: family.familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  const integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId);
  for (const [index, title] of titles.entries()) {
    const start = new Date(START.getTime() + (index + 1) * 86_400_000);
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId,
      eventId: `evt-${index}`,
      familyId: family.familyId,
      userId: family.parentUserId,
      startAt: start,
      endAt: new Date(start.getTime() + 3_600_000),
      kidRelated: true,
      title,
      calendarStanding: 'organizer',
      status: 'confirmed',
      updatedStamp: '1',
    });
    await db.database.insert(schema.activityBookings).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      messageId: `m-${index}`,
      providerHost: 'rec.example.test',
      title,
      firstSessionAt: start,
      eventId: null,
    });
  }
  const read = await channelScheduleReader(db.database, NOW).connectedWeek(
    family.familyId,
    START,
    END,
    DAY_KEYS,
  );
  return {
    blocks: read.blocks.map((block) => block.title),
    activities: read.activities.map((activity) => activity.title),
  };
}

describe('coach connected week · a teenager with no name on file (rule #1)', () => {
  it('an unnamed only child of 14: no block title or booking reaches the model', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await connectedWeek([{ name: null, years: 14 }], ['hockey practice'])).toEqual({
      blocks: [PRIVATE_EVENT_WHAT],
      activities: [],
    });
  });

  it('a named 14-year-old: a title naming them is private, as on main', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await connectedWeek([{ name: 'Rowan', years: 14 }], ['Rowan hockey'])).toEqual({
      blocks: [PRIVATE_EVENT_WHAT],
      activities: [],
    });
  });

  it("positive control: a named 8-year-old's titles reach the model", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await connectedWeek([{ name: 'Mia', years: 8 }], ['hockey practice'])).toEqual({
      blocks: ['hockey practice'],
      activities: ['hockey practice'],
    });
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's titles are private, the 8-year-old's show", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(
      await connectedWeek(
        [
          { name: 'Mia', years: 8 },
          { name: null, years: 15 },
        ],
        ['Mia swim', 'driving lesson'],
      ),
    ).toEqual({
      blocks: ['Mia swim', PRIVATE_EVENT_WHAT],
      activities: ['Mia swim'],
    });
  });
});
