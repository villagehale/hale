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
let parentUserId: string;
let coParentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
  ({ familyId, parentUserId } = await seedFamily(db.database));
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Other Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  coParentUserId = co.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParentUserId, role: 'co_parent' });
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
    fact('told_by_parent', '555-0101', {
      memorySource: 'parent_message',
      sourceAudience: 'one_to_one',
      sourceUserId: parentUserId,
    }),
    fact('told_by_co_parent', '555-0106', {
      memorySource: 'parent_message',
      sourceAudience: 'one_to_one',
      sourceUserId: coParentUserId,
    }),
    fact('read_off_email', '555-0102', { memorySource: 'inferred' }),
    fact('read_off_calendar', '555-0103', { memorySource: 'calendar' }),
    fact('no_longer_true', '555-0104', {
      memorySource: 'parent_message',
      validUntil: new Date('2026-10-15T00:00:00.000Z'),
      sourceAudience: 'one_to_one',
      sourceUserId: parentUserId,
    }),
    fact('expired', '555-0105', {
      memorySource: 'parent_message',
      memoryKind: 'temporary',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
      sourceAudience: 'one_to_one',
      sourceUserId: parentUserId,
    }),
  ]);
});

afterAll(async () => {
  await db.close();
});

describe('loadParentStatedFacts (VIL-628)', () => {
  it('returns only the live facts this parent told Hale', async () => {
    const port = productionChannelCoachPorts(db.database).loadParentStatedFacts;
    if (!port) throw new Error('production ports do not wire loadParentStatedFacts');
    const values = (await port(familyId, parentUserId, NOW)).join('\n');
    expect(values).toContain('555-0101');
    for (const phone of ['555-0102', '555-0103', '555-0104', '555-0105', '555-0106']) {
      expect(values).not.toContain(phone);
    }
  });

  it('a single-parent family: an inferred fact is still not trusted', async () => {
    // With no other adult, audience scoping hides nothing, so only the source check
    // keeps a fact read off an email out.
    const solo = await seedFamily(db.database, 'Solo Family');
    await db.database.insert(schema.familyMemoryFacts).values(
      [
        ['told_by_parent', '555-0111', 'parent_message'],
        ['read_off_email', '555-0112', 'inferred'],
      ].map(([factKey, phone, memorySource]) => ({
        familyId: solo.familyId,
        factType: 'preference' as const,
        factKey: factKey as string,
        factValue: { summary: `office ${phone}` },
        confidence: 0.9,
        validFrom: new Date('2026-10-01T00:00:00.000Z'),
        memorySource: memorySource as 'parent_message' | 'inferred',
        ...(memorySource === 'parent_message'
          ? { sourceAudience: 'one_to_one' as const, sourceUserId: solo.parentUserId }
          : {}),
      })),
    );
    const port = productionChannelCoachPorts(db.database).loadParentStatedFacts;
    if (!port) throw new Error('production ports do not wire loadParentStatedFacts');
    const values = (await port(solo.familyId, solo.parentUserId, NOW)).join('\n');
    expect(values).toContain('555-0111');
    expect(values).not.toContain('555-0112');
  });
});
