import { readFileSync } from 'node:fs';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadAgentContext } from './context';

/**
 * VIL-519 preview proof (deploy 767125fb6). The find slice already held a stale
 * guess back and dropped a shadow home_city. The coach prompt did not: it still
 * handed the swimming value and Georgetown to the model, and it read families.city
 * instead of the postal code the parent had corrected to.
 */
const NOW = new Date('2026-10-30T15:00:00.000Z');
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('coach context — stale facts and the current postal code (VIL-519)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);
  afterEach(async () => {
    await db?.close();
  });

  it('lets L3P win over a seeded Georgetown city and a remembered home_city, and does not hand a stale swimming guess over as a fact', async () => {
    const { familyId } = await seedFamily(db.database, 'Preview Ada');
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
      factType: 'logistic',
      factKey: 'home_city',
      factValue: { city: 'Georgetown' },
      confidence: 1,
      inferredBy: 'preview-seed',
      validFrom: DAYS(20),
      memoryKind: 'lasting',
      memorySource: 'parent_message',
      sourcedAt: DAYS(20),
    });
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

    const context = await loadAgentContext(
      {
        familyId,
        question: 'anything fun Lin could do this Sunday afternoon?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );

    expect(context.location.city).toBe('Markham');
    const shown = JSON.stringify({
      location: context.location,
      memoryFacts: context.memoryFacts,
      memoryBrief: context.memoryBrief.text,
    });
    expect(shown).not.toContain('Georgetown');
    expect(shown).not.toContain('loves_swimming');
    expect(shown).not.toContain('swimming');
    expect(shown).toContain('indoor');
    expect(context.memoryFacts.map((fact) => fact.factKey)).toEqual(['indoor']);
  });
});

describe('nearby-find skill — recheck is not a pick and not a template', () => {
  const skill = readFileSync(resolveRepoFile('packages/agent/skills/coach-nearby-find.md'), 'utf8');

  it('tells the model a recheck must not choose the pick, and that it writes the question', () => {
    expect(skill).toContain('must not choose');
    expect(skill).toContain('own words');
    expect(skill).toContain('no set sentence');
  });
});
