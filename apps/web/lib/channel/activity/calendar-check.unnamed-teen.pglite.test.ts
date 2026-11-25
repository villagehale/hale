import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import { loadCheckbackCalendar } from '~/lib/channel/next-day-checkback/recheck';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { loadWatchCalendar } from './calendar-check';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. The watch-calendar reads (the VIL-564 watch check and the next-day
 * re-check) hand the model no event title a 13+ child with no name could own.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
const ZONE = 'America/Chicago';
const NOW = new Date('2026-12-01T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function household(
  children: ReadonlyArray<{ name: string | null; years: number }>,
  titles: readonly string[],
) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test family', provinceOrState: 'IL', countryCode: 'US' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: null, timezone: ZONE })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  for (const child of children) {
    const born = new Date(NOW);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  for (const [index, title] of titles.entries()) {
    await db.database.insert(schema.familyEvents).values({
      familyId,
      childId: null,
      title,
      startsAt: new Date(NOW.getTime() + (index + 1) * 86_400_000),
      source: 'parent',
    });
    await db.database.insert(schema.activityBookings).values({
      familyId,
      parentUserId,
      integrationId: '00000000-0000-4000-8000-000000000001',
      messageId: `m-${index}`,
      providerHost: 'rec.example.test',
      title: `${title} booking`,
      firstSessionAt: new Date(NOW.getTime() + (index + 2) * 86_400_000),
      eventId: null,
    });
  }
  return { familyId, parentUserId };
}

/** Every title the watch check and the next-day re-check would hand the model. */
async function titlesTheModelSees(home: { familyId: string; parentUserId: string }) {
  const input = { ...home, subjectChildId: null, now: NOW };
  const titles: string[] = [];
  for (const read of [
    await loadWatchCalendar(db.database, input),
    await loadCheckbackCalendar(db.database, input),
  ]) {
    if (read.status !== 'read') throw new Error(`expected a calendar read, got ${read.status}`);
    titles.push(...read.calendar.map((entry) => entry.title));
  }
  return titles.sort();
}

describe('watch-calendar reads · a teenager with no name on file (rule #1)', () => {
  it('an unnamed only child of 14: no title reaches the model', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: null, years: 14 }], ['hockey practice']);
    expect(await titlesTheModelSees(home)).toEqual([]);
  });

  it('a named 14-year-old who is the only child is hidden the same way', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: 'Rowan', years: 14 }], ['hockey practice']);
    expect(await titlesTheModelSees(home)).toEqual([]);
  });

  it("positive control: a named 8-year-old's titles still reach the model", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household([{ name: 'Mia', years: 8 }], ['hockey practice']);
    expect(await titlesTheModelSees(home)).toEqual([
      'hockey practice',
      'hockey practice',
      'hockey practice booking',
    ]);
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's titles are hidden, the 8-year-old's show", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    const home = await household(
      [
        { name: 'Mia', years: 8 },
        { name: null, years: 15 },
      ],
      ['Mia swim', 'driving lesson'],
    );
    expect(await titlesTheModelSees(home)).toEqual(['Mia swim', 'Mia swim', 'Mia swim booking']);
  });
});
