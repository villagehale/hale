import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { matchedDurationMinutes } from './email-alert';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function event(familyId: string, startsAt: Date, endsAt: Date | null) {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title: 'Storytime', startsAt, endsAt, source: 'parent' })
    .returning({ id: schema.familyEvents.id });
  return { table: 'family_events' as const, id: row?.id as string };
}

describe('matchedDurationMinutes', () => {
  it("is the matched calendar row's own length, and null without an end", async () => {
    const { familyId } = await seedFamily(db.database, 'Duration');
    const start = new Date('2026-09-19T17:00:00Z');
    const timed = await event(familyId, start, new Date('2026-09-19T17:45:00Z'));
    const open = await event(familyId, start, null);
    expect(await matchedDurationMinutes(db.database, familyId, timed)).toBe(45);
    expect(await matchedDurationMinutes(db.database, familyId, open)).toBeNull();
    expect(await matchedDurationMinutes(db.database, familyId, null)).toBeNull();
    expect(
      await matchedDurationMinutes(db.database, familyId, { table: 'week_plans_item', id: 'x' }),
    ).toBeNull();
    // Another family's row is never read.
    const other = await seedFamily(db.database, 'Other');
    expect(await matchedDurationMinutes(db.database, other.familyId, timed)).toBeNull();
  });
});
