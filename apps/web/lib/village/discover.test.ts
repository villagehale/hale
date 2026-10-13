import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readCandidates } from '~/lib/channel/intake/radar';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { discoverForFamily } from './discover';
import { findFamilyActivities } from './live';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
async function family(age = 36, city = 'New York') {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city, province: 'NY' })
    .where(eq(schema.families.id, familyId));
  await seedChild(db.database, familyId, 'PrivateChildName', age);
  return familyId;
}
const pick = {
  name: 'Live art workshop',
  ageFit: 'ages 2-5',
  when: 'October 18, 2026 at 10am',
  price: 'Free',
  sourceName: 'Public museum',
  source: 'web' as const,
  sourceUrl: 'https://museum.org/art',
  eventDate: '2026-10-18',
  indoorOutdoor: 'indoor' as const,
};

describe('live recommendations without a catalog', () => {
  it('keeps a known venue identity for review ranking, never an ambiguous shared URL', async () => {
    const familyId = await family();
    const venueId = randomUUID();
    await db.database.insert(schema.familyActivityHistory).values({
      familyId,
      title: 'Earlier receipt',
      kind: 'activity',
      summary: 'Not current facts',
      source: 'web',
      confidence: 1,
      civicVenueId: venueId,
      sourceUrl: pick.sourceUrl,
    });
    const finder = { find: async () => ({ found: true as const, picks: [{ ...pick }] }) };
    expect(
      (await findFamilyActivities(db.database, familyId, { finder })).picks[0]?.civicVenueId,
    ).toBe(venueId);
    // Multiple receipts for one identity are not an ambiguous shared venue URL.
    await db.database.insert(schema.familyActivityHistory).values({
      familyId,
      title: 'Another receipt',
      kind: 'activity',
      summary: 'Not current facts',
      source: 'web',
      confidence: 1,
      civicVenueId: venueId,
      sourceUrl: pick.sourceUrl,
    });
    expect(
      (await findFamilyActivities(db.database, familyId, { finder })).picks[0]?.civicVenueId,
    ).toBe(venueId);
    await db.database.insert(schema.familyActivityHistory).values({
      familyId,
      title: 'Different venue',
      kind: 'activity',
      summary: 'Not current facts',
      source: 'web',
      confidence: 1,
      civicVenueId: randomUUID(),
      sourceUrl: pick.sourceUrl,
    });
    expect(
      (await findFamilyActivities(db.database, familyId, { finder })).picks[0]?.civicVenueId,
    ).toBeUndefined();
  });
  it('does not use another family receipt to identify a fresh result', async () => {
    const owner = await family();
    const other = await family();
    await db.database.insert(schema.familyActivityHistory).values({
      familyId: other,
      title: 'Private receipt',
      kind: 'activity',
      summary: 'Not current facts',
      source: 'web',
      confidence: 1,
      civicVenueId: randomUUID(),
      sourceUrl: pick.sourceUrl,
    });
    const finder = { find: async () => ({ found: true as const, picks: [{ ...pick }] }) };
    const found = await findFamilyActivities(db.database, owner, { finder });
    expect(found.picks[0]?.civicVenueId).toBeUndefined();
    expect(found.picks[0]?.name).toBe(pick.name);
  });
  it('researches each operation, returns only fresh picks, and preserves offered receipts', async () => {
    const familyId = await family();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ found: true, picks: [pick] })
      .mockResolvedValueOnce({
        found: true,
        picks: [{ ...pick, when: 'October 25, 2026 at 11am', eventDate: '2026-10-25' }],
      });
    const first = await discoverForFamily(familyId, db.database, { finder: { find } });
    const second = await discoverForFamily(
      familyId,
      db.database,
      { finder: { find } },
      { searchSeason: 'fall' },
    );
    expect(first.status).toBe('discovered');
    expect(second.status).toBe('discovered');
    expect(find).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(find.mock.calls)).not.toContain('PrivateChildName');
    expect(find.mock.calls[0]![0].town).toBe('New York, NY');
    const rows = await db.database
      .select()
      .from(schema.familyActivityHistory)
      .where(eq(schema.familyActivityHistory.familyId, familyId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.offeredAt !== null)).toBe(true);
    expect(rows.map((row) => row.eventDate)).toEqual(['2026-10-18', '2026-10-25']);
    const tables = await db.client.query<{ name: string }>(
      "select tablename as name from pg_tables where tablename in ('village_candidates','registration_windows','civic_sessions','civic_venues')",
    );
    expect(tables.rows).toEqual([]);
  });
  it('failed live research never returns a saved receipt or writes an unused candidate pool', async () => {
    const familyId = await family();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ found: true, picks: [pick] })
      .mockResolvedValueOnce({ found: false, reason: 'ground_failed' });
    await discoverForFamily(familyId, db.database, { finder: { find } });
    const current = await findFamilyActivities(db.database, familyId, { finder: { find } });
    expect(current).toEqual({ picks: [], reason: 'ground_failed' });
    const rows = await db.database
      .select()
      .from(schema.familyActivityHistory)
      .where(eq(schema.familyActivityHistory.familyId, familyId));
    expect(rows).toHaveLength(1);
  });
  it('refuses missing location, child names and teen-only searches before web spend', async () => {
    const find = vi.fn();
    const teen = await family(180);
    expect((await findFamilyActivities(db.database, teen, { finder: { find } })).reason).toBe(
      'no_non_teen_children',
    );
    const noArea = await family(36, '');
    expect((await findFamilyActivities(db.database, noArea, { finder: { find } })).reason).toBe(
      'no_area',
    );
    const own = await family();
    expect(
      (
        await findFamilyActivities(db.database, own, {
          subject: 'PrivateChildName art',
          finder: { find },
        })
      ).picks,
    ).toEqual([]);
    expect(
      (
        await findFamilyActivities(db.database, own, {
          subject: 'Test Parent art',
          finder: { find },
        })
      ).picks,
    ).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
  it('nudge candidates are freshly sourced and require an explicit date and link', async () => {
    const familyId = await family();
    const find = vi.fn().mockResolvedValue({
      found: true,
      picks: [pick, { ...pick, name: 'Undated', eventDate: undefined }],
    });
    const rows = await readCandidates(db.database, familyId, {
      finder: { find },
      window: 'this coming weekend',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'web',
      sourceUrl: pick.sourceUrl,
      eventDate: pick.eventDate,
    });
    expect(find.mock.calls[0]![0].window).toBe('this coming weekend');
    expect(
      await db.database
        .select()
        .from(schema.familyActivityHistory)
        .where(eq(schema.familyActivityHistory.familyId, familyId)),
    ).toEqual([]);
  });
});
