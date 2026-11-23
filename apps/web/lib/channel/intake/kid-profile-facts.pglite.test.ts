import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { factsForContext } from '@hale/worker/memory-context';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recallFamilyMemory } from '~/lib/memory/store';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { keepKidActivities } from './kid-activity-facts';
import { KID_PROFILE_FACT_KEY, keepKidProfiles } from './kid-profile-facts';

/**
 * VIL-721 · the kids' names and ages the model read in the thread, kept in family memory
 * with their provenance on real Postgres. The record (the `children` row) stays what
 * every prompt reads, so a remembered age can never go stale in a reply (VIL-519): this
 * row is the provenance of what the parent said, and it reaches no prompt.
 */

const NOW = new Date('2026-11-20T15:00:00.000Z');
const LATER = new Date('2026-11-21T15:00:00.000Z');
const SESSION = '77777777-7777-4777-8777-777777777777';

describe('keepKidProfiles', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function profiles(familyId: string) {
    return db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          eq(schema.familyMemoryFacts.factKey, KID_PROFILE_FACT_KEY),
        ),
      );
  }

  async function keptAudits(familyId: string) {
    return db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'onboarding_kids_kept'),
        ),
      );
  }

  it("keeps each kid's name and age on that kid, with provenance and a counts-only audit row", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const maya = await seedChild(db.database, familyId, 'Maya', 72, undefined, NOW);
    const leo = await seedChild(db.database, familyId, 'Leo', 18, undefined, NOW);

    const outcome = await keepKidProfiles(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      children: [
        { name: 'Leo', ageMonths: 18, agePrecision: 'months' },
        { name: 'Maya', ageMonths: 72, agePrecision: 'years' },
      ],
      heardIn: 'one_to_one',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'kept', count: 2, skipped: 0 });
    const facts = await profiles(familyId);
    expect(facts).toHaveLength(2);
    const byChild = new Map(facts.map((fact) => [fact.childId, fact]));
    expect(byChild.get(maya)?.factValue).toEqual({
      schemaVersion: 1,
      kind: 'kid_profile',
      name: 'Maya',
      ageMonths: 72,
      agePrecision: 'years',
    });
    expect(byChild.get(leo)?.factValue).toEqual({
      schemaVersion: 1,
      kind: 'kid_profile',
      name: 'Leo',
      ageMonths: 18,
      agePrecision: 'months',
    });
    for (const fact of facts) {
      expect(fact).toMatchObject({
        factType: 'logistic',
        inferredBy: 'onboarding_thread_v2_record',
        sourceAudience: 'one_to_one',
        sourceUserId: parentUserId,
        memorySource: 'parent_message',
        memoryKind: 'lasting',
        validUntil: null,
      });
      expect(fact.validFrom.toISOString()).toBe(NOW.toISOString());
      expect(fact.sourcedAt?.toISOString()).toBe(NOW.toISOString());
    }
    const audits = await keptAudits(familyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: parentUserId,
      targetTable: 'sms_intake_sessions',
      targetId: SESSION,
      after: { count: 2 },
    });
    expect(JSON.stringify(audits[0]?.after)).not.toMatch(/Maya|Leo/);
  });

  it('reaches no prompt and no recall: the record is what Hale reads', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedChild(db.database, familyId, 'Ava', 60, undefined, NOW);
    await keepKidProfiles(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      children: [{ name: 'Ava', ageMonths: 60, agePrecision: 'years' }],
      heardIn: 'one_to_one',
      now: NOW,
    });
    // The positive control: an activity kept the same way does reach the prompt read.
    await keepKidActivities(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      activities: [{ child: 'Ava', activity: 'ballet', when: null }],
      heardIn: 'one_to_one',
      now: NOW,
    });

    const read = await factsForContext(db.database, familyId, {
      reader: { adult: parentUserId },
      now: LATER,
      limit: 50,
    });
    expect(read.map((fact) => fact.factKey)).toEqual(['kid-activity-ballet']);

    const recalled = await recallFamilyMemory(db.database, {
      familyId,
      now: LATER,
      reader: { adult: parentUserId },
    });
    expect(recalled.map((fact) => fact.factKey)).toEqual(['kid-activity-ballet']);
  });

  it('a corrected age replaces the kept one and leaves a followable chain', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const kid = await seedChild(db.database, familyId, 'Noor', 36, undefined, NOW);
    const keep = (ageMonths: number, now: Date) =>
      keepKidProfiles(db.database, {
        familyId,
        parentUserId,
        sessionId: SESSION,
        children: [{ name: 'Noor', ageMonths, agePrecision: 'years' }],
        heardIn: 'one_to_one',
        now,
      });

    await keep(36, NOW);
    await keep(48, LATER);

    const facts = await profiles(familyId);
    expect(facts).toHaveLength(2);
    const live = facts.find((fact) => fact.validUntil === null);
    const closed = facts.find((fact) => fact.validUntil !== null);
    expect(live?.childId).toBe(kid);
    expect(live?.factValue).toMatchObject({ ageMonths: 48 });
    expect(closed?.factValue).toMatchObject({ ageMonths: 36 });
    expect(closed?.supersededBy).toBe(live?.id);
  });

  it('puts a kid with no name on the only child, and never guesses between two', async () => {
    const only = await seedFamily(db.database);
    const onlyChild = await seedChild(db.database, only.familyId, 'your child', 48, undefined, NOW);
    const placed = await keepKidProfiles(db.database, {
      familyId: only.familyId,
      parentUserId: only.parentUserId,
      sessionId: SESSION,
      children: [{ name: null, ageMonths: 48, agePrecision: 'years' }],
      heardIn: 'one_to_one',
      now: NOW,
    });
    expect(placed).toEqual({ status: 'kept', count: 1, skipped: 0 });
    const [fact] = await profiles(only.familyId);
    expect(fact?.childId).toBe(onlyChild);
    expect(fact?.factValue).toMatchObject({ name: null, ageMonths: 48 });

    const two = await seedFamily(db.database);
    await seedChild(db.database, two.familyId, 'Maya', 72, undefined, NOW);
    await seedChild(db.database, two.familyId, 'Leo', 48, undefined, NOW);
    const unplaced = await keepKidProfiles(db.database, {
      familyId: two.familyId,
      parentUserId: two.parentUserId,
      sessionId: SESSION,
      children: [{ name: null, ageMonths: 30, agePrecision: 'years' }],
      heardIn: 'one_to_one',
      now: NOW,
    });
    expect(unplaced).toEqual({ status: 'nothing_to_keep', skipped: 1 });
    expect(await profiles(two.familyId)).toEqual([]);
    expect(await keptAudits(two.familyId)).toEqual([]);
  });

  it("never files a named kid with no row of their own on another kid's row", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const leo = await seedChild(db.database, familyId, 'Leo', 48, undefined, NOW);

    const outcome = await keepKidProfiles(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      children: [
        { name: 'Maya', ageMonths: 72, agePrecision: 'years' },
        { name: 'Leo', ageMonths: 48, agePrecision: 'years' },
      ],
      heardIn: 'one_to_one',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'kept', count: 1, skipped: 1 });
    const facts = await profiles(familyId);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.childId).toBe(leo);
    expect(facts[0]?.factValue).toMatchObject({ name: 'Leo', ageMonths: 48 });
    const [audit] = await keptAudits(familyId);
    expect(audit?.after).toEqual({ count: 1, skipped: 1 });
  });

  it('names a failed write and stores nothing, so the turn goes on', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedChild(db.database, familyId, 'Maya', 72, undefined, NOW);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async () => {
            throw new Error('write refused');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;
    try {
      const outcome = await keepKidProfiles(broken, {
        familyId,
        parentUserId,
        sessionId: SESSION,
        children: [{ name: 'Maya', ageMonths: 72, agePrecision: 'years' }],
        heardIn: 'one_to_one',
        now: NOW,
      });
      expect(outcome).toEqual({ status: 'failed' });
      expect(await profiles(familyId)).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
