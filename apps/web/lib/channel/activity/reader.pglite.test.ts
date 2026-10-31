import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import {
  FAMILY_FIT_PREFERENCE_LIMIT,
  FAMILY_FIT_READ_LIMIT,
  productionActivityFamilyReader,
} from './reader';

const NOW = new Date('2026-10-30T12:00:00Z');
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('family fit provenance + freshness (VIL-519, pglite)', () => {
  let db: TestDb;
  const reader = productionActivityFamilyReader();

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);
  afterEach(async () => {
    await db?.close();
  });

  async function fact(
    familyId: string,
    childId: string | null,
    key: string,
    value: unknown,
    opts: {
      source?: 'parent_message' | 'inferred' | 'legacy';
      seenDaysAgo?: number;
      confidence?: number;
    } = {},
  ) {
    const seen = DAYS(opts.seenDaysAgo ?? 1);
    return writeFact(db.database, {
      familyId,
      childId,
      factType: 'preference',
      factKey: key,
      factValue: value,
      confidence: opts.confidence ?? 0.9,
      inferredBy: 'test',
      validFrom: seen,
      memoryKind: 'lasting',
      memorySource: opts.source ?? 'parent_message',
      sourcedAt: seen,
    });
  }

  it('a corrected age wins in the next find; a remembered old age never rides', async () => {
    const { familyId } = await seedFamily(db.database);
    const child = await seedChild(db.database, familyId, 'Zephyrina', 36, undefined, NOW);
    await fact(familyId, child, 'age', 3);
    // The parent corrects the date of birth: she is 5, not 3.
    await db.database
      .update(schema.children)
      .set({ dateOfBirth: '2021-06-01' })
      .where(eq(schema.children.id, child));

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.children[0]?.ageYears).toBe(5);
    expect(JSON.stringify(fit.preferences)).not.toContain('"age"');
    expect(JSON.stringify(fit.recheck)).not.toContain('"age"');
  });

  it('a corrected home area wins; a remembered home_city is dropped', async () => {
    const { familyId } = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ areaCoarse: 'M5V' })
      .where(eq(schema.families.id, familyId));
    await fact(familyId, null, 'home_city', 'toronto');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: 'L3P' })
      .where(eq(schema.families.id, familyId));

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.homeArea).toBe('markham');
    expect(JSON.stringify(fit)).not.toContain('toronto');
  });

  it('a contradiction updates the fact: one live row, the newest value', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'setting', 'outdoor', { seenDaysAgo: 10 });
    await fact(familyId, null, 'setting', 'indoor', { seenDaysAgo: 1 });

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    const settings = fit.preferences.filter((p) => p.key === 'setting');
    expect(settings).toEqual([
      {
        childId: null,
        key: 'setting',
        value: 'indoor',
        source: 'parent_message',
        seenOn: '2026-10-29',
      },
    ]);
  });

  it.each(['dateofbirth', 'date_of_birth', 'dateOfBirth'])(
    'a remembered %s never argues with the corrected record (Devin #981)',
    async (key) => {
      const { familyId } = await seedFamily(db.database);
      const child = await seedChild(db.database, familyId, 'Zephyrina', 36, undefined, NOW);
      await fact(familyId, child, key, '2023-06-01');
      await db.database
        .update(schema.children)
        .set({ dateOfBirth: '2021-06-01' })
        .where(eq(schema.children.id, child));

      const fit = await reader.familyFit!(db.database, familyId, NOW);
      expect(fit.children[0]?.ageYears).toBe(5);
      expect(fit.preferences).toEqual([]);
      expect(fit.recheck).toEqual([]);
    },
  );

  it('old high-confidence facts cannot fill the read cap and starve a fresh one (Devin #981)', async () => {
    const { familyId } = await seedFamily(db.database);
    for (let i = 0; i < 40; i++) {
      await fact(familyId, null, `old_${i}`, i, {
        source: 'inferred',
        seenDaysAgo: 200,
        confidence: 1,
      });
    }
    await fact(familyId, null, 'stroller', true, { source: 'parent_message', confidence: 0.7 });

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.preferences.map((p) => p.key)).toEqual(['stroller']);
  });

  it('a parent-stated fact survives 32+ newer inferred guesses filling the read cap (Devin #981)', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'not_scary', true, { source: 'parent_message', seenDaysAgo: 60 });
    for (let i = 0; i < FAMILY_FIT_READ_LIMIT + 8; i++) {
      await fact(familyId, null, `guess_${i}`, i, {
        source: 'inferred',
        seenDaysAgo: 1,
        confidence: 1,
      });
    }

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.preferences[0]).toMatchObject({ key: 'not_scary', source: 'parent_message' });
    expect(fit.preferences).toHaveLength(FAMILY_FIT_PREFERENCE_LIMIT);
  });

  it('a stale fact is held back for recheck (key only), never ranked or its value shown', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'scary', 'avoid', { source: 'inferred', seenDaysAgo: 120 });
    await fact(familyId, null, 'stroller', true, { source: 'inferred', seenDaysAgo: 30 });
    await fact(familyId, null, 'language', 'french', { source: 'legacy', seenDaysAgo: 400 });

    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.preferences.map((p) => p.key)).toEqual(['stroller']);
    expect(fit.preferences[0]?.source).toBe('inferred');
    expect(fit.recheck).toHaveLength(1);
    expect(['language', 'scary']).toContain(fit.recheck[0]?.key);
    expect(JSON.stringify(fit.recheck)).not.toContain('french');
    expect(JSON.stringify(fit.recheck)).not.toContain('avoid');
  });

  it('expired and closed facts are not used at all', async () => {
    const { familyId } = await seedFamily(db.database);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'this_week_indoor',
      factValue: true,
      confidence: 0.9,
      inferredBy: 'test',
      validFrom: DAYS(5),
      memoryKind: 'temporary',
      memorySource: 'parent_message',
      sourcedAt: DAYS(5),
      expiresAt: DAYS(1),
    });
    const fit = await reader.familyFit!(db.database, familyId, NOW);
    expect(fit.preferences).toEqual([]);
    expect(fit.recheck).toEqual([]);
  });
});
