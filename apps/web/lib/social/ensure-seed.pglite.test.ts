import { schema } from '@hale/db';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { ensureSocialSeed } from './ensure-seed';
import { SOCIAL_SEED, profileUrlFor } from './seed';

/**
 * The seed upsert is the only writer of the curated watchlist. A second run
 * must not add rows, an inactive handle must stay inactive, and a poll
 * watermark must survive the refresh.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

async function sourceCount(): Promise<number> {
  const [row] = await db.database.select({ n: count() }).from(schema.watchedSources);
  return Number(row?.n ?? 0);
}

describe('ensureSocialSeed', () => {
  it('upserts every SOCIAL_SEED row and maps platform, ingest, and geo fields', async () => {
    const first = await ensureSocialSeed(db.database);
    expect(first.upserted).toBe(SOCIAL_SEED.length);
    expect(await sourceCount()).toBe(SOCIAL_SEED.length);

    const instagram = SOCIAL_SEED.find(
      (row) => row.platform === 'instagram' && row.handle === 'acton_georgetownearlyon',
    );
    const facebook = SOCIAL_SEED.find(
      (row) => row.platform === 'facebook_page' && row.handle === 'links2care',
    );
    if (!instagram || !facebook) throw new Error('expected seed rows were missing');

    const [ig] = await db.database
      .select()
      .from(schema.watchedSources)
      .where(
        and(
          eq(schema.watchedSources.platform, 'instagram'),
          eq(schema.watchedSources.handle, instagram.handle),
        ),
      );
    expect(ig).toMatchObject({
      displayName: instagram.displayName,
      profileUrl: profileUrlFor(instagram),
      accountType: 'business',
      ingestMethod: 'graph_business_discovery',
      tosRisk: 'official',
      geoCity: instagram.city,
      geoFsa: instagram.fsa,
      notes: instagram.note,
      languages: ['en'],
      priority: 2,
      pollCadenceMinutes: 720,
      active: true,
      category: instagram.category,
      region: instagram.region,
    });

    const [page] = await db.database
      .select()
      .from(schema.watchedSources)
      .where(
        and(
          eq(schema.watchedSources.platform, 'facebook_page'),
          eq(schema.watchedSources.handle, facebook.handle),
        ),
      );
    expect(page).toMatchObject({
      profileUrl: profileUrlFor(facebook),
      accountType: 'page',
      ingestMethod: 'fb_ppca',
      tosRisk: 'official',
      active: true,
    });
  });

  it('keeps the row count, inactive rows, and poll watermarks on a second call', async () => {
    const inactive = SOCIAL_SEED.filter((row) => !row.active);
    expect(inactive.length).toBeGreaterThan(0);

    const target = SOCIAL_SEED.find(
      (row) => row.platform === 'instagram' && row.handle === 'acton_georgetownearlyon',
    );
    if (!target) throw new Error('instagram example missing from SOCIAL_SEED');

    const polledAt = new Date('2026-09-01T15:04:00.000Z');
    const mediaId = '17890000000000001';
    await db.database
      .update(schema.watchedSources)
      .set({
        lastPolledAt: polledAt,
        lastMediaId: mediaId,
        displayName: 'stale display name',
      })
      .where(
        and(
          eq(schema.watchedSources.platform, target.platform),
          eq(schema.watchedSources.handle, target.handle),
        ),
      );

    const before = await sourceCount();
    const again = await ensureSocialSeed(db.database);
    expect(again.upserted).toBe(SOCIAL_SEED.length);
    expect(await sourceCount()).toBe(before);

    const [row] = await db.database
      .select()
      .from(schema.watchedSources)
      .where(
        and(
          eq(schema.watchedSources.platform, target.platform),
          eq(schema.watchedSources.handle, target.handle),
        ),
      );
    expect(row?.lastMediaId).toBe(mediaId);
    expect(row?.lastPolledAt?.toISOString()).toBe(polledAt.toISOString());
    expect(row?.displayName).toBe(target.displayName);

    const storedInactive = await db.database
      .select({
        platform: schema.watchedSources.platform,
        handle: schema.watchedSources.handle,
      })
      .from(schema.watchedSources)
      .where(eq(schema.watchedSources.active, false));
    expect(storedInactive).toHaveLength(inactive.length);
    for (const source of inactive) {
      expect(storedInactive).toContainEqual({ platform: source.platform, handle: source.handle });
    }
  });
});
