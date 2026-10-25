import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { discoverForFamily } from './discover';
import { findFamilyActivities, recordActivityOffers, unofferedActivityPicks } from './live';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
const pick: ActivityPick = {
  name: 'Museum art',
  sourceName: 'Museum',
  source: 'web',
  sourceUrl: 'https://museum.org/art',
  ageFit: 'ages 2-5',
  when: 'October 20 at 10 AM',
  eventDate: '2026-10-20',
  price: 'Free',
};
async function family() {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'Toronto', province: 'ON', areaCoarse: 'M5V' })
    .where(eq(schema.families.id, familyId));
  await seedChild(db.database, familyId, 'Private child name', 36);
  return familyId;
}

describe('family-local recommendation history', () => {
  it('suppresses the same occurrence after a fresh read, without exporting the history', async () => {
    const familyId = await family();
    const find = vi.fn().mockResolvedValue({ found: true, picks: [pick] });
    const first = await discoverForFamily(familyId, db.database, { finder: { find } });
    const second = await discoverForFamily(familyId, db.database, { finder: { find } });
    expect(first).toMatchObject({ status: 'discovered', insertedCount: 1 });
    expect(second).toMatchObject({ status: 'discovered', insertedCount: 0 });
    expect(find).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(find.mock.calls)).not.toContain(pick.sourceUrl);
    expect(JSON.stringify(find.mock.calls)).not.toContain('Private child name');
    expect(find.mock.calls[0]?.[0].town).toBe('Toronto');
  });

  it('VIL-451 · a repeat parent read still shows the current activity, on the same receipt', async () => {
    const familyId = await family();
    const find = vi.fn().mockResolvedValue({ found: true, picks: [pick] });
    const first = await discoverForFamily(familyId, db.database, { finder: { find } });
    const second = await discoverForFamily(familyId, db.database, { finder: { find } });
    if (first.status !== 'discovered' || second.status !== 'discovered') throw new Error('status');
    expect(first.offeredIds).toHaveLength(1);
    expect(second.offeredIds).toEqual(first.offeredIds);
    expect(second.insertedCount).toBe(0);
  });

  it('keeps a different date or program and ignores tracking-only URL changes', async () => {
    const familyId = await family();
    await recordActivityOffers(db.database, familyId, [pick]);
    const nextDate = { ...pick, eventDate: '2026-10-27' };
    const otherProgram = { ...pick, name: 'Museum clay' };
    const result = await unofferedActivityPicks(db.database, familyId, [
      { ...pick, name: ' MUSEUM   ART ', sourceUrl: `${pick.sourceUrl}?utm_source=email#details` },
      nextDate,
      otherProgram,
    ]);
    expect(result).toEqual([nextDate, otherProgram]);
  });

  it('never uses another family’s history to suppress an offer', async () => {
    const owner = await family();
    const other = await family();
    await recordActivityOffers(db.database, other, [pick]);
    expect(await unofferedActivityPicks(db.database, owner, [pick])).toEqual([pick]);
  });

  it('an explicit follow-up returns newly read facts even for an earlier offer', async () => {
    const familyId = await family();
    await recordActivityOffers(db.database, familyId, [pick]);
    const refreshed = { ...pick, price: '$12', when: 'October 20 at 11 AM' };
    const result = await findFamilyActivities(db.database, familyId, {
      subject: 'Museum art details',
      finder: { find: async () => ({ found: true, picks: [refreshed] }) },
    });
    expect(result.picks[0]?.price).toBe('$12');
    expect(result.picks[0]?.when).toBe('October 20 at 11 AM');
  });

  it('an unsent read does not consume the recommendation and duplicate results are collapsed', async () => {
    const familyId = await family();
    const finder = { find: async () => ({ found: true as const, picks: [pick, pick] }) };
    expect(
      (
        await findFamilyActivities(db.database, familyId, {
          finder,
          excludePreviouslyOffered: true,
        })
      ).picks,
    ).toEqual([pick]);
    expect(
      (
        await findFamilyActivities(db.database, familyId, {
          finder,
          excludePreviouslyOffered: true,
        })
      ).picks,
    ).toEqual([pick]);
    expect(
      await db.database
        .select()
        .from(schema.familyActivityHistory)
        .where(eq(schema.familyActivityHistory.familyId, familyId)),
    ).toEqual([]);
  });
});
