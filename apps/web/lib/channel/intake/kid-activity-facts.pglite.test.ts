import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { keepKidActivities, kidActivityFactKey } from './kid-activity-facts';

/**
 * VIL-721 · what the kids already do, kept as family memory on real Postgres: one
 * `routine` fact per activity, on the kid it names (or the only kid), with its
 * provenance on the row and no child name in the value, plus one counts-only audit row.
 */

const NOW = new Date('2026-11-20T15:00:00.000Z');
const LATER = new Date('2026-11-21T15:00:00.000Z');
const SESSION = '77777777-7777-4777-8777-777777777777';

describe('keepKidActivities', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function factsOf(familyId: string) {
    return db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
  }

  async function keptAudits(familyId: string) {
    return db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'onboarding_activities_kept'),
        ),
      );
  }

  it('puts each activity on the kid it names, the unnamed one on the household, with its provenance', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const maya = await seedChild(db.database, familyId, 'Maya', 72, undefined, NOW);
    const leo = await seedChild(db.database, familyId, 'Leo', 48, undefined, NOW);

    const outcome = await keepKidActivities(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      activities: [
        { child: 'Maya', activity: 'swim lessons', when: 'Saturdays' },
        { child: 'Leo', activity: 'soccer', when: null },
        { child: null, activity: 'library story time', when: null },
      ],
      heardIn: 'one_to_one',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'kept', count: 3, linked: 2 });
    const facts = await factsOf(familyId);
    expect(facts).toHaveLength(3);
    const byKey = new Map(facts.map((fact) => [fact.factKey, fact]));
    expect(byKey.get('kid-activity:swim-lessons')?.childId).toBe(maya);
    expect(byKey.get('kid-activity:soccer')?.childId).toBe(leo);
    // Two kids and no name: the household's, never a guess at which kid.
    expect(byKey.get('kid-activity:library-story-time')?.childId).toBeNull();
    for (const fact of facts) {
      expect(fact).toMatchObject({
        factType: 'routine',
        inferredBy: 'onboarding_thread_v2',
        sourceAudience: 'one_to_one',
        sourceUserId: parentUserId,
        memorySource: 'parent_message',
        memoryKind: 'lasting',
        validUntil: null,
      });
      expect(fact.confidence).toBeCloseTo(0.9);
      expect(fact.validFrom.toISOString()).toBe(NOW.toISOString());
      expect(fact.sourcedAt?.toISOString()).toBe(NOW.toISOString());
      expect(JSON.stringify(fact.factValue)).not.toMatch(/Maya|Leo/);
    }
    expect(byKey.get('kid-activity:swim-lessons')?.factValue).toEqual({
      schemaVersion: 1,
      kind: 'kid_activity',
      activity: 'swim lessons',
      when: 'Saturdays',
    });

    const audits = await keptAudits(familyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: parentUserId,
      targetTable: 'sms_intake_sessions',
      targetId: SESSION,
      after: { count: 3, linked: 2 },
    });
    expect(JSON.stringify(audits[0]?.after)).not.toMatch(/swim|soccer|story/);
  });

  it('puts an activity that names no kid on the only kid', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const only = await seedChild(db.database, familyId, 'Ava', 60, undefined, NOW);
    await keepKidActivities(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      activities: [{ child: null, activity: 'ballet', when: 'Tuesdays' }],
      heardIn: 'one_to_one',
      now: NOW,
    });
    const [fact] = await factsOf(familyId);
    expect(fact?.childId).toBe(only);
  });

  it('records a group thread as heard by the family', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedChild(db.database, familyId, 'Ava', 60, undefined, NOW);
    await keepKidActivities(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      activities: [{ child: 'Ava', activity: 'piano', when: null }],
      heardIn: 'family',
      now: NOW,
    });
    const [fact] = await factsOf(familyId);
    expect(fact).toMatchObject({ sourceAudience: 'family', sourceUserId: parentUserId });
  });

  it('keeps nothing and writes nothing for an empty list', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const outcome = await keepKidActivities(db.database, {
      familyId,
      parentUserId,
      sessionId: SESSION,
      activities: [],
      heardIn: 'one_to_one',
      now: NOW,
    });
    expect(outcome).toEqual({ status: 'nothing_to_keep' });
    expect(await factsOf(familyId)).toEqual([]);
    expect(await keptAudits(familyId)).toEqual([]);
  });

  it('supersedes the same activity said again: one live row, the old one closed and chained', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedChild(db.database, familyId, 'Maya', 72, undefined, NOW);
    const keep = (when: string | null, now: Date) =>
      keepKidActivities(db.database, {
        familyId,
        parentUserId,
        sessionId: SESSION,
        activities: [{ child: 'Maya', activity: 'swim lessons', when }],
        heardIn: 'one_to_one',
        now,
      });
    await keep('Saturdays', NOW);
    await keep('Sundays', LATER);

    const facts = await factsOf(familyId);
    expect(facts).toHaveLength(2);
    const live = facts.filter((fact) => fact.validUntil === null);
    const closed = facts.filter((fact) => fact.validUntil !== null);
    expect(live).toHaveLength(1);
    expect(live[0]?.factValue).toMatchObject({ when: 'Sundays' });
    expect(closed[0]?.supersededBy).toBe(live[0]?.id);
  });

  it('names a failed write and never throws into the turn', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedChild(db.database, familyId, 'Maya', 72, undefined, NOW);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      const outcome = await keepKidActivities(broken, {
        familyId,
        parentUserId,
        sessionId: SESSION,
        activities: [{ child: 'Maya', activity: 'swim lessons', when: null }],
        heardIn: 'one_to_one',
        now: NOW,
      });
      expect(outcome).toEqual({ status: 'failed' });
      expect(await factsOf(familyId)).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('kidActivityFactKey', () => {
  it('folds an activity to a key of letters and digits', () => {
    expect(kidActivityFactKey('Swim Lessons!')).toBe('kid-activity:swim-lessons');
    expect(kidActivityFactKey('Natation à Laval')).toBe('kid-activity:natation-a-laval');
  });

  it('keys a phrase in another script on a short, stable hash of itself', () => {
    const key = kidActivityFactKey('游泳');
    expect(key).toMatch(/^kid-activity:h-[0-9a-f]{12}$/);
    expect(kidActivityFactKey('游泳')).toBe(key);
  });

  it('cuts a long phrase to at most sixty characters with no trailing dash', () => {
    const key = kidActivityFactKey(`${'a'.repeat(59)} b and more words`);
    const slug = key.slice('kid-activity:'.length);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});
