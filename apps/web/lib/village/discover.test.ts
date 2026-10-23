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
async function family(age = 36, city = 'Toronto') {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city, areaCoarse: city ? 'M5V' : null })
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
  it('accepts the current main Finder URL without inventing a dated session', async () => {
    const familyId = await family();
    const legacy = {
      name: pick.name,
      ageFit: pick.ageFit,
      when: null,
      price: null,
      sourceName: pick.sourceName,
      source: 'web' as const,
      url: pick.sourceUrl,
    };
    const finder = { find: async () => ({ found: true as const, picks: [legacy] }) };
    const result = await findFamilyActivities(db.database, familyId, { finder });
    expect(result.picks[0]?.sourceUrl).toBe(pick.sourceUrl);
    expect(result.picks[0]?.eventDate).toBeUndefined();
    expect(await readCandidates(db.database, familyId, { finder })).toEqual([]);
  });
  it('qualifies the Finder municipality without leaking the postal prefix', async () => {
    const familyId = await family(36, 'Burlington');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: 'L7M', province: 'ON', country: 'Canada' })
      .where(eq(schema.families.id, familyId));
    const find = vi.fn().mockResolvedValue({ found: true, picks: [pick] });
    await findFamilyActivities(db.database, familyId, { finder: { find } });
    expect(find.mock.calls[0]![0].town).toBe('Burlington, Ontario, Canada');
    expect(JSON.stringify(find.mock.calls)).not.toContain('L7M');
  });

  it('supports a non-GTA city with its province and country', async () => {
    const familyId = await family(36, 'Victoria');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: null, province: 'BC', country: 'Canada' })
      .where(eq(schema.families.id, familyId));
    const find = vi.fn().mockResolvedValue({ found: true, picks: [pick] });
    expect((await findFamilyActivities(db.database, familyId, { finder: { find } })).picks).toEqual(
      [pick],
    );
    expect(find.mock.calls[0]![0].town).toBe('Victoria, British Columbia, Canada');
  });

  it('does not guess an Ontario municipality for an unmapped foreign family', async () => {
    const familyId = await family(36, 'Burlington');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: null, province: 'VT', country: 'US' })
      .where(eq(schema.families.id, familyId));
    const find = vi.fn().mockResolvedValue({ found: true, picks: [pick] });
    await findFamilyActivities(db.database, familyId, { finder: { find } });
    expect(find.mock.calls[0]![0].town).toBe('Burlington, VT, United States');
  });

  it('preserves checked sources and unconfirmed references when no pick is confirmed', async () => {
    const familyId = await family();
    const reference = {
      name: pick.name,
      sourceName: pick.sourceName,
      sourceUrl: pick.sourceUrl,
      ageFit: null,
      when: null,
      price: null,
      status: 'unconfirmed' as const,
      evidence: {
        program: pick.name,
        age: null,
        sessions: [],
        schedule: null,
        price: null,
        history: null,
        windowConfirmed: false,
      },
    };
    const searched = {
      town: 'Toronto, Ontario, Canada',
      notes: 'Research notes',
      references: [reference],
      checkedSources: [pick.sourceUrl],
    };
    const finder = {
      find: async () => ({ found: false as const, reason: 'no_picks' as const, searched }),
    };
    expect(await findFamilyActivities(db.database, familyId, { finder })).toEqual({
      picks: [],
      reason: 'no_picks',
      references: [reference],
      checkedSources: [pick.sourceUrl],
    });
  });

  it('preserves confirmed session evidence and checked sources in successful results', async () => {
    const familyId = await family();
    const evidence = {
      program: pick.name,
      age: pick.ageFit,
      sessions: ['October 18, 2026 at 10am'],
      schedule: null,
      price: 'Free',
      history: null,
      windowConfirmed: true,
    };
    const sourced = { ...pick, evidence };
    const finder = {
      find: async () => ({
        found: true as const,
        picks: [sourced],
        references: [],
        checkedSources: [pick.sourceUrl],
      }),
    };
    expect(await findFamilyActivities(db.database, familyId, { finder })).toEqual({
      picks: [sourced],
      reason: null,
      references: [],
      checkedSources: [pick.sourceUrl],
    });
  });

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
    expect(find.mock.calls[0]![0].town).toBe('Toronto, Ontario, Canada');
    const rows = await db.database
      .select()
      .from(schema.familyActivityHistory)
      .where(eq(schema.familyActivityHistory.familyId, familyId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.offeredAt !== null)).toBe(true);
    expect(rows.map((row) => row.eventDate)).toEqual(['2026-10-18', '2026-10-25']);
    const tables = await db.client.query<{ name: string }>(
      "select tablename as name from pg_tables where tablename in ('village_candidates','village_feed_rank')",
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
  it('does not leak a household name stored as an unmapped city', async () => {
    const familyId = await family(36, 'PrivateChildName');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: null, country: 'Canada' })
      .where(eq(schema.families.id, familyId));
    const find = vi.fn();
    expect((await findFamilyActivities(db.database, familyId, { finder: { find } })).reason).toBe(
      'names_a_person',
    );
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
