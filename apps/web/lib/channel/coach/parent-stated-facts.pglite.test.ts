import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionChannelCoachPorts } from '~/lib/channel/coach/runtime';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-628 · after read_email, the reply may repeat a number from a fact only when the
 * parent told Hale that fact. The production port reads it from the real table: one row
 * of each source sits next to it, and only the parent's own comes back.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');

let db: TestDb;
let familyId: string;

beforeAll(async () => {
  db = await createTestDb();
  ({ familyId } = await seedFamily(db.database));
  const fact = (
    factKey: string,
    phone: string,
    extra: Partial<typeof schema.familyMemoryFacts.$inferInsert>,
  ) => ({
    familyId,
    factType: 'preference' as const,
    factKey,
    factValue: { summary: `office ${phone}` },
    confidence: 0.9,
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    ...extra,
  });
  await db.database.insert(schema.familyMemoryFacts).values([
    fact('told_by_parent', '555-0101', { memorySource: 'parent_message' }),
    fact('read_off_email', '555-0102', { memorySource: 'inferred' }),
    fact('read_off_calendar', '555-0103', { memorySource: 'calendar' }),
    fact('no_longer_true', '555-0104', {
      memorySource: 'parent_message',
      validUntil: new Date('2026-10-15T00:00:00.000Z'),
    }),
    fact('expired', '555-0105', {
      memorySource: 'parent_message',
      memoryKind: 'temporary',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    }),
  ]);
});

afterAll(async () => {
  await db.close();
});

describe('loadParentStatedFacts (VIL-628)', () => {
  it('returns only the live facts the parent told Hale', async () => {
    const port = productionChannelCoachPorts(db.database).loadParentStatedFacts;
    if (!port) throw new Error('production ports do not wire loadParentStatedFacts');
    const values = (await port(familyId, NOW)).join('\n');
    expect(values).toContain('555-0101');
    for (const phone of ['555-0102', '555-0103', '555-0104', '555-0105']) {
      expect(values).not.toContain(phone);
    }
  });
});
