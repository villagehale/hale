import { schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { rememberCalendarChanges } from './household-calendar';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. The household calendar sync stores no title a 13+ child with no
 * name could own, so no group line can say it later.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
const DAY = new Date('2026-09-25T18:00:00.000Z');

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

function change(eventId: string, title: string): CalendarChange {
  return {
    eventId,
    title,
    updated: 'stamp-1',
    status: 'confirmed',
    start: { dateTime: '2026-09-26T19:00:00.000Z' },
    end: { dateTime: '2026-09-26T20:00:00.000Z' },
    standing: 'organizer',
  };
}

async function storedTitles(
  children: ReadonlyArray<{ name: string | null; years: number }>,
  titles: readonly string[],
): Promise<Array<{ eventId: string; title: string | null }>> {
  const family = await seedFamily(db.database, 'Calendar household');
  for (const child of children) {
    const born = new Date(DAY);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId: family.familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  const integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId);
  await rememberCalendarChanges(db.database, {
    integrationId,
    familyId: family.familyId,
    userId: family.parentUserId,
    changes: titles.map((title, index) => change(`evt-${index}`, title)),
    children: await db.database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, family.familyId)),
    seeding: false,
    bothCalendars: true,
    now: DAY,
  });
  return db.database
    .select({
      eventId: schema.parentCalendarBlocks.eventId,
      title: schema.parentCalendarBlocks.title,
    })
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, family.familyId))
    .orderBy(asc(schema.parentCalendarBlocks.eventId));
}

describe('household calendar sync · a teenager with no name on file (rule #1)', () => {
  it('an unnamed only child of 14: the title is not stored', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await storedTitles([{ name: null, years: 14 }], ['hockey practice'])).toEqual([
      { eventId: 'evt-0', title: null },
    ]);
  });

  it('a named 14-year-old who is the only child: the title is not stored', async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await storedTitles([{ name: 'Rowan', years: 14 }], ['hockey practice'])).toEqual([
      { eventId: 'evt-0', title: null },
    ]);
  });

  it("positive control: a named 8-year-old's title is stored", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(await storedTitles([{ name: 'Mia', years: 8 }], ['hockey practice'])).toEqual([
      { eventId: 'evt-0', title: 'hockey practice' },
    ]);
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's title is not stored, the 8-year-old's is", async () => {
    vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
    expect(
      await storedTitles(
        [
          { name: 'Mia', years: 8 },
          { name: null, years: 15 },
        ],
        ['Mia swim', 'hockey practice'],
      ),
    ).toEqual([
      { eventId: 'evt-0', title: 'Mia swim' },
      { eventId: 'evt-1', title: null },
    ]);
  });
});
