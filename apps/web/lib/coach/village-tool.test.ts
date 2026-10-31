import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import { linkRef } from '~/lib/channel/coach/activity-links';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { searchVillageTool } from './tools';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

const pick: ActivityPick = {
  name: 'Current swim',
  ageFit: 'ages 2-5',
  when: 'Saturday 10 AM',
  price: null,
  sourceName: 'Current pool',
  source: 'web',
  sourceUrl: 'https://example.org/current',
};

async function household(teen = false, city: string | null = 'Toronto') {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city, areaCoarse: city ? 'M5V' : null })
    .where(eq(schema.families.id, familyId));
  await seedChild(db.database, familyId, 'Private child name', teen ? 180 : 36);
  return familyId;
}
async function search(
  familyId: string,
  finder: ActivityFinder,
  recorder?: (rows: readonly unknown[]) => void,
  input: unknown = {},
) {
  return invokeTool(
    searchVillageTool(db.database, recorder, finder),
    input,
    { familyId, actor: 'test' },
    { writeAudit: async () => {} },
  ) as Promise<{
    candidates: { title: string; when: string; url?: string; ref?: string }[];
    liveRead: string;
  }>;
}

describe('search_village uses this operation’s live evidence', () => {
  it('forwards the requested operator and month rather than defaulting to this year', async () => {
    const familyId = await household(false, 'Toronto');
    await db.database
      .update(schema.families)
      .set({ province: 'ON', country: 'Canada' })
      .where(eq(schema.families.id, familyId));
    const find = vi.fn<ActivityFinder['find']>().mockResolvedValue({ found: true, picks: [pick] });
    await search(familyId, { find }, undefined, {
      query: 'Toronto Public Library storytimes',
      window: 'October 2026',
    });
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      subject: 'Toronto Public Library storytimes',
      window: 'October 2026',
      town: 'Toronto',
    });
  });

  it('searches the town the parent named instead of the home area', async () => {
    const familyId = await household(false, 'Toronto');
    const find = vi.fn<ActivityFinder['find']>().mockResolvedValue({ found: true, picks: [pick] });
    await search(familyId, { find }, undefined, {
      query: 'trick or treat',
      window: 'this weekend',
      area: 'Oakville',
    });
    expect(find.mock.calls[0]?.[0]).toMatchObject({
      subject: 'trick or treat',
      window: 'this weekend',
      town: 'Oakville',
    });
  });

  it('offers fresh facts and records exactly the offered receipt, never an old schedule', async () => {
    const familyId = await household();
    await db.database.insert(schema.familyActivityHistory).values({
      familyId,
      title: 'Stale October 20',
      kind: 'class',
      summary: 'Old dates',
      source: 'legacy',
      confidence: 1,
    });
    const find = vi.fn<ActivityFinder['find']>().mockResolvedValue({ found: true, picks: [pick] });
    const offers: unknown[] = [];
    const result = await search(familyId, { find }, (rows) => offers.push(...rows));
    expect(result.candidates.map((row) => row.title)).toEqual(['Current swim']);
    // The model sees the page's ref, never the URL (coach/activity-links.ts).
    expect(result.candidates[0]).not.toHaveProperty('url');
    expect(result.candidates[0]?.ref).toBe(linkRef(pick.sourceUrl as string));
    expect(offers).toEqual([
      expect.objectContaining({
        title: 'Current swim',
        venue: 'Current pool',
        candidateId: expect.any(String),
        url: pick.sourceUrl,
      }),
    ]);
    expect(JSON.stringify(find.mock.calls)).not.toContain('Private child name');
    const receipts = await db.database
      .select()
      .from(schema.familyActivityHistory)
      .where(eq(schema.familyActivityHistory.familyId, familyId));
    expect(receipts.filter((row) => row.offeredAt !== null)).toHaveLength(1);
  });

  it('a failed live read never falls back to saved history', async () => {
    const familyId = await household();
    await db.database.insert(schema.familyActivityHistory).values({
      familyId,
      title: 'Old option',
      kind: 'class',
      summary: 'Old dates',
      source: 'legacy',
      confidence: 1,
    });
    const result = await search(familyId, {
      find: async () => ({ found: false, reason: 'ground_failed' }),
    });
    expect(result.candidates).toEqual([]);
    expect(result.liveRead).toBe('ground_failed');
  });

  it('keeps an unknown clock unknown instead of inventing one', async () => {
    const familyId = await household();
    const result = await search(familyId, {
      find: async () => ({ found: true, picks: [{ ...pick, when: null }] }),
    });
    expect(result.candidates[0]?.when).toBe('Current time could not be verified');
  });

  it('does not search for a teen-only household', async () => {
    const familyId = await household(true);
    const find = vi.fn<ActivityFinder['find']>();
    const result = await search(familyId, { find });
    expect(find).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.liveRead).toBe('no_non_teen_children');
  });

  it('asks for location rather than guessing a city when none is known', async () => {
    const familyId = await household(false, null);
    const find = vi.fn<ActivityFinder['find']>();
    const result = await search(familyId, { find });
    expect(find).not.toHaveBeenCalled();
    expect(result.liveRead).toBe('no_area');
  });
});
