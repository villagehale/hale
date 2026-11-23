import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadFamilyMemoryExport } from '~/lib/rights/export-memory';
import { runDeletionSweep } from '~/lib/rights/delete';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { keepKidActivities } from './kid-activity-facts';
import { KID_PROFILE_FACT_KEY, keepKidProfiles } from './kid-profile-facts';

/**
 * VIL-721 · what the walk keeps is the family's to get a copy of and to erase, and a keep
 * told in one parent's own thread is that parent's row on the trail.
 */
const NOW = new Date('2026-11-20T15:00:00.000Z');
const LATER = new Date('2026-11-21T15:00:00.000Z');
const SESSION = '77777777-7777-4777-8777-777777777777';

describe('what the in-thread walk keeps', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function kept(heardIn: 'one_to_one' | 'family') {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const childId = await seedChild(db.database, familyId, 'Maya', 60, undefined, NOW);
    const common = { familyId, parentUserId, sessionId: SESSION, heardIn, now: NOW };
    await keepKidProfiles(db.database, {
      ...common,
      children: [{ name: 'Maya', ageMonths: 60, agePrecision: 'years' }],
    });
    await keepKidActivities(db.database, {
      ...common,
      activities: [{ child: 'Maya', activity: 'ballet', when: 'Tuesdays' }],
    });
    return { familyId, parentUserId, childId };
  }

  const auditOf = async (familyId: string, action: string) =>
    (
      await db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, familyId))
    ).filter((row) => row.actionTaken === action);

  it.each(['onboarding_kids_kept', 'onboarding_activities_kept'])(
    'puts %s on the one parent who said it in their own thread',
    async (action) => {
      const { familyId, parentUserId } = await kept('one_to_one');
      const [row] = await auditOf(familyId, action);
      expect(row?.audience).toBe(parentUserId);
    },
  );

  it.each(['onboarding_kids_kept', 'onboarding_activities_kept'])(
    'leaves %s on the family when it was said where every adult reads',
    async (action) => {
      const { familyId } = await kept('family');
      const [row] = await auditOf(familyId, action);
      expect(row?.actionTaken).toBe(action);
      expect(row?.audience).toBeNull();
    },
  );

  it('is in the parent’s copy of their data, with where it came from', async () => {
    const { familyId, parentUserId, childId } = await kept('one_to_one');
    const copy = await loadFamilyMemoryExport(
      db.database,
      familyId,
      [{ id: childId, name: 'Maya', dateOfBirth: '2021-11-20' }],
      { userId: parentUserId },
      LATER,
    );
    const keys = copy.facts.map((fact) => fact.factKey).sort();
    expect(keys).toEqual(['kid-activity-ballet', KID_PROFILE_FACT_KEY].sort());
    const words = JSON.stringify(copy.facts);
    expect(words).toContain('ballet');
    expect(words).toContain('parent_message');
  });

  it('is gone when the family is erased', async () => {
    const { familyId } = await kept('one_to_one');
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: NOW })
      .where(eq(schema.families.id, familyId));

    await runDeletionSweep(db.database, LATER, async () => undefined);

    const left = await db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(left).toEqual([]);
    const families = await db.database
      .select({ id: schema.families.id })
      .from(schema.families)
      .where(eq(schema.families.id, familyId));
    expect(families).toEqual([]);
  });
});
