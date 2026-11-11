import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invokeTool } from '@hale/agent';
import { linkRef } from '~/lib/channel/coach/activity-links';
import { toSmsReply } from '~/lib/channel/coach/reply';
import type { ActivityQuery } from './deidentify';
import { findActivitiesTool } from './tools';
import { loadAgentContext } from '~/lib/coach/context';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import {
  FAMILY_FIT_PREFERENCE_LIMIT,
  bindActivityReader,
  productionActivityFamilyReader,
} from './reader';

const NOW = new Date('2026-10-30T12:00:00Z');
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
/** More rows than any read limit, so ordering before the LIMIT is what decides. */
const MANY = 40;

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
      heard: 'unrecorded',
      validFrom: seen,
      memoryKind: 'lasting',
      memorySource: opts.source ?? 'parent_message',
      sourcedAt: seen,
    });
  }

  it('a corrected age wins in the next find; a remembered old age never rides', async () => {
    const { familyId } = await seedFamily(db.database);
    const child = await seedChild(db.database, familyId, 'Zephyrina', 36, undefined, NOW);
    await fact(familyId, child, 'âge', { record: 'age', years: 3 });
    // The parent corrects the date of birth: she is 5, not 3.
    await db.database
      .update(schema.children)
      .set({ dateOfBirth: '2021-06-01' })
      .where(eq(schema.children.id, child));

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
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
    await fact(familyId, null, 'home_city', { record: 'place', text: 'Georgetown' });
    await fact(familyId, null, 'ville', { record: 'place', text: 'Georgetown' });
    await fact(familyId, null, 'quartier', { record: 'place', text: 'Georgetown' });
    await fact(familyId, null, 'lives_in', { record: 'place', text: 'Georgetown' });
    await fact(familyId, null, 'ville_market', 'weekend market');
    await db.database
      .update(schema.families)
      .set({ areaCoarse: 'L3P' })
      .where(eq(schema.families.id, familyId));

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.homeArea).toBe('Markham');
    expect(fit.preferences.map((p) => p.key)).toEqual(['ville_market']);
    expect(JSON.stringify(fit)).not.toContain('Georgetown');
  });

  it('a contradiction updates the fact: one live row, the newest value', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'setting', 'outdoor', { seenDaysAgo: 10 });
    await fact(familyId, null, 'setting', 'indoor', { seenDaysAgo: 1 });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
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

  it.each(['dateofbirth', 'date_of_birth', 'dateOfBirth', 'edad'])(
    'a remembered %s marked as age never argues with the corrected record',
    async (key) => {
      const { familyId } = await seedFamily(db.database);
      const child = await seedChild(db.database, familyId, 'Zephyrina', 36, undefined, NOW);
      await fact(familyId, child, key, { record: 'age', text: '2023-06-01' });
      await db.database
        .update(schema.children)
        .set({ dateOfBirth: '2021-06-01' })
        .where(eq(schema.children.id, child));

      const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
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
        seenDaysAgo: 400,
        confidence: 1,
      });
    }
    await fact(familyId, null, 'stroller', true, { source: 'parent_message', confidence: 0.7 });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences.map((p) => p.key)).toEqual(['stroller']);
  });

  it('a parent-stated fact survives 32+ newer inferred guesses filling the read cap (Devin #981)', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'not_scary', true, { source: 'parent_message', seenDaysAgo: 60 });
    for (let i = 0; i < MANY; i++) {
      await fact(familyId, null, `guess_${i}`, i, {
        source: 'inferred',
        seenDaysAgo: 1,
        confidence: 1,
      });
    }

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences[0]).toMatchObject({ key: 'not_scary', source: 'parent_message' });
    expect(fit.preferences).toHaveLength(FAMILY_FIT_PREFERENCE_LIMIT);
  });

  it('a stale guess is absent from the find result even when fresh facts fill the cap', async () => {
    const { familyId } = await seedFamily(db.database);
    for (let i = 0; i < MANY; i++) {
      await fact(familyId, null, `said_${i}`, i, { source: 'parent_message', seenDaysAgo: 300 });
    }
    await fact(familyId, null, 'loves_swimming', 'Lin loves swimming lessons', {
      source: 'inferred',
      seenDaysAgo: 400,
    });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.recheck).toEqual([]);
    expect(JSON.stringify(fit)).not.toMatch(/swim/i);
  });

  it('a stale fact is omitted entirely, never ranked and never named', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'scary', 'avoid', { source: 'inferred', seenDaysAgo: 400 });
    await fact(familyId, null, 'stroller', true, { source: 'inferred', seenDaysAgo: 30 });
    await fact(familyId, null, 'language', 'french', { source: 'legacy', seenDaysAgo: 400 });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences.map((p) => p.key)).toEqual(['stroller']);
    expect(fit.preferences[0]?.source).toBe('inferred');
    expect(fit.recheck).toEqual([]);
    expect(JSON.stringify(fit)).not.toContain('french');
    expect(JSON.stringify(fit)).not.toContain('avoid');
    expect(JSON.stringify(fit)).not.toContain('scary');
  });

  it('an unmarked stale home_city Georgetown does not reach the find or the coach', async () => {
    const { familyId } = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ postalCode: 'L3P 3J7', areaCoarse: 'L3P', city: 'Markham', country: 'Canada' })
      .where(eq(schema.families.id, familyId));
    // Parent-said facts last 365 days. 400 is past that window. A 20-day row is not.
    await fact(familyId, null, 'home_city', 'Georgetown', {
      source: 'parent_message',
      seenDaysAgo: 400,
    });
    await fact(familyId, null, 'indoor', 'indoors', {
      source: 'parent_message',
      seenDaysAgo: 20,
    });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences.map((p) => p.key)).toEqual(['indoor']);
    expect(JSON.stringify(fit)).not.toContain('Georgetown');

    const context = await loadAgentContext(
      {
        familyId,
        question: 'anything fun this Sunday?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    const shown = JSON.stringify({
      memoryFacts: context.memoryFacts,
      brief: context.memoryBrief.text,
    });
    expect(shown).not.toContain('Georgetown');
    expect(shown).toContain('indoor');
  });

  it('a newer marked fact under the same key does not erase an older unmarked preference (Devin #981)', async () => {
    const { familyId } = await seedFamily(db.database);
    await fact(familyId, null, 'school', 'likes the after-school club', { seenDaysAgo: 5 });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'school',
      factValue: { record: 'place', text: 'Georgetown' },
      confidence: 0.9,
      inferredBy: 'test',
      heard: 'unrecorded',
      validFrom: DAYS(1),
      memoryKind: 'lasting',
      memorySource: 'parent_message',
      sourcedAt: DAYS(1),
    });

    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences.map((p) => [p.key, p.value])).toEqual([
      ['school', 'likes the after-school club'],
    ]);
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
      heard: 'unrecorded',
      validFrom: DAYS(5),
      memoryKind: 'temporary',
      memorySource: 'parent_message',
      sourcedAt: DAYS(5),
      expiresAt: DAYS(1),
    });
    const fit = await reader.familyFit!(db.database, familyId, 'every_adult', NOW);
    expect(fit.preferences).toEqual([]);
    expect(fit.recheck).toEqual([]);
  });
});

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

it('does not guess a country for a legacy city/region row that never recorded one', async () => {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'New York', province: 'NY', country: null })
    .where(eq(schema.families.id, familyId));
  const reader = bindActivityReader(db.database, productionActivityFamilyReader(), 'every_adult');
  expect(await reader.place(familyId)).toEqual({ status: 'unknown', reason: 'no_country' });
});

it('resolves a US ZIP without sending it to the Finder tool', async () => {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: null, province: null, country: 'US', postalCode: '05401', areaCoarse: '054' })
    .where(eq(schema.families.id, familyId));
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Fixture child', dateOfBirth: '2023-01-01' });
  const reader = bindActivityReader(db.database, productionActivityFamilyReader(), 'every_adult');
  expect(await reader.place(familyId)).toEqual({
    status: 'known',
    town: 'Burlington, Vermont, United States',
  });
  const queries: ActivityQuery[] = [];
  const finder = {
    find: async (query: ActivityQuery) => {
      queries.push(query);
      return { found: true as const, picks: [] };
    },
  };
  await invokeTool(
    findActivitiesTool({ reader, finder, onPromise: () => {} }),
    { subject: 'library storytimes', window: 'October 2026' },
    { familyId, actor: 'fixture-parent' },
    {
      writeAudit: async () => {},
      checkChildContentAccess: async () => ({ ok: true, reason: 'ok' }),
    },
  );
  expect(queries).toHaveLength(1);
  expect(queries[0]?.town).toBe('Burlington, Vermont, United States');
  expect(JSON.stringify(queries)).not.toContain('054');
  await db.database
    .insert(schema.familyAreas)
    .values({ familyId, city: 'Burlington', province: 'VT', postalCode: '05401', isActive: true });
  expect(await reader.place(familyId)).toEqual({
    status: 'known',
    town: 'Burlington, Vermont, United States',
  });
});

it('keeps the London request and exact filtered page through the tool-to-SMS path', async () => {
  const { familyId, parentUserId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'London', province: 'ON', country: 'Canada', areaCoarse: 'N6A' })
    .where(eq(schema.families.id, familyId));
  const url = 'https://www.lpl.ca/whats-on?audience=Kids&date=2026-10#events';
  const queries: ActivityQuery[] = [];
  const links: { title: string; url: string }[] = [];
  const tool = findActivitiesTool({
    reader: bindActivityReader(db.database, productionActivityFamilyReader(), 'every_adult'),
    finder: {
      find: async (query) => {
        queries.push(query);
        return {
          found: true,
          picks: [
            {
              name: 'STEAM Storytime',
              sourceName: 'London Public Library',
              ageFit: 'ages 2+',
              when: 'October 2026',
              price: null,
              source: 'web',
              sourceUrl: url,
              url,
            },
          ],
        };
      },
    },
    onPromise: () => {},
    onLinks: (offered) => links.push(...offered),
  });
  await invokeTool(
    tool,
    { subject: 'London Public Library storytimes', window: 'October 2026' },
    { familyId, actor: parentUserId },
    {
      writeAudit: async () => {},
      checkChildContentAccess: async () => ({ ok: true, reason: 'ok' }),
    },
  );
  expect(queries[0]).toMatchObject({
    subject: 'London Public Library storytimes',
    window: 'October 2026',
    town: 'London, Ontario, Canada',
  });
  expect(
    toSmsReply(`STEAM Storytime. [${linkRef(url)}]`, {
      children: [],
      now: new Date(),
      activityLinks: links.map(({ url }) => ({ url, ref: linkRef(url) })),
    }),
  ).toBe(`STEAM Storytime. ${url}`);
});

it('reads a saved non-GTA location and then its active area without leaking a postal code', async () => {
  const { familyId } = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ city: 'London', province: 'ON', country: 'Canada', areaCoarse: 'N6A' })
    .where(eq(schema.families.id, familyId));
  const reader = bindActivityReader(db.database, productionActivityFamilyReader(), 'every_adult');
  expect(await reader.place(familyId)).toEqual({
    status: 'known',
    town: 'London, Ontario, Canada',
  });
  await db.database
    .insert(schema.familyAreas)
    .values({ familyId, city: 'Victoria', province: 'BC', postalCode: 'V8W 1P6', isActive: true });
  expect(await reader.place(familyId)).toEqual({
    status: 'known',
    town: 'Victoria, British Columbia, Canada',
  });
  await db.database
    .update(schema.familyAreas)
    .set({ city: '42 Main Street', postalCode: null })
    .where(eq(schema.familyAreas.familyId, familyId));
  expect((await reader.place(familyId)).status).toBe('unknown');
});
