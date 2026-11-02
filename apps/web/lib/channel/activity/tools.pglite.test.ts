import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { ActivityQuery } from './deidentify';
import type { ActivityPick } from './lane';
import { bindActivityReader, productionActivityFamilyReader } from './reader';
import { findActivitiesTool } from './tools';

/**
 * VIL-519 design gate. The family has a stale swimming guess, a fresh indoor
 * preference, and place facts in more than one language. The find that follows
 * the fresh preference must not search swimming, must not return a swimming pick,
 * and must not name Georgetown.
 */
const NOW = new Date();
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function guardDeps(): GuardDeps {
  return {
    async writeAudit() {},
    async checkChildContentAccess() {
      return { ok: true, reason: 'ok' };
    },
  };
}

describe('find_activities with a stale swimming guess (VIL-519)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);
  afterEach(async () => {
    await db?.close();
  });

  it('searches the fresh indoor preference, not swimming, and never names Georgetown', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Preview Ada');
    await db.database
      .update(schema.families)
      .set({
        city: 'Georgetown',
        country: 'Canada',
        province: 'Ontario',
        postalCode: 'L3P 3J7',
        areaCoarse: 'L3P',
      })
      .where(eq(schema.families.id, familyId));

    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'loves_swimming',
      factValue: 'Lin loves swimming lessons',
      confidence: 0.9,
      inferredBy: 'preview-seed',
      validFrom: DAYS(120),
      memoryKind: 'lasting',
      memorySource: 'inferred',
      sourcedAt: DAYS(120),
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'indoor',
      factValue: 'indoors',
      confidence: 0.9,
      inferredBy: 'preview-seed',
      validFrom: DAYS(2),
      memoryKind: 'lasting',
      memorySource: 'parent_message',
      sourcedAt: DAYS(2),
    });
    for (const key of ['home_city', 'ville', 'quartier', 'lives_in']) {
      await writeFact(db.database, {
        familyId,
        childId: null,
        factType: 'logistic',
        factKey: key,
        factValue: { record: 'place', text: 'Georgetown' },
        confidence: 1,
        inferredBy: 'preview-seed',
        validFrom: DAYS(20),
        memoryKind: 'lasting',
        memorySource: 'parent_message',
        sourcedAt: DAYS(20),
      });
    }

    const reader = bindActivityReader(db.database, productionActivityFamilyReader());
    const readFit = reader.familyFit;
    if (!readFit) throw new Error('familyFit missing');
    const fit = await readFit(familyId);
    expect(fit.preferences.map((p) => p.key)).toEqual(['indoor']);
    expect(fit.recheck).toEqual([]);
    expect(fit.homeArea).toBe('markham');

    const seen: ActivityQuery[] = [];
    const tool = findActivitiesTool({
      reader,
      finder: {
        async find(query) {
          seen.push(query);
          const pick: ActivityPick = {
            name: query.subject,
            ageFit: 'school age',
            when: null,
            price: null,
            sourceName: 'fixture',
            source: 'web',
          };
          return { found: true, picks: [pick] };
        },
      },
      onPromise: () => {},
    });

    const subject = fit.preferences[0]?.key;
    expect(subject).toBe('indoor');
    const result = await invokeTool(
      tool,
      { subject },
      { familyId, actor: parentUserId },
      guardDeps(),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.subject).toBe('indoor');
    expect(seen[0]?.town).toBe('Markham');
    expect(JSON.stringify(seen)).not.toMatch(/swim/i);
    expect(JSON.stringify(seen)).not.toContain('Georgetown');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/swim/i);
    expect(serialized).not.toContain('Georgetown');
    expect(serialized).not.toContain('ville');
    expect(serialized).not.toContain('quartier');
    expect(serialized).not.toContain('lives_in');
    expect(serialized).toContain('indoor');
    expect(serialized).toContain('markham');
  });
});
