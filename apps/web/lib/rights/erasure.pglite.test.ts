import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { DELETION_GRACE_MS, requestErasure } from './delete';

/**
 * VIL-355 · WHICH erasure a request means depends on who is asking, and the answer is
 * read from `family_members` rather than assumed from the session. Against the real DDL
 * because the whole point is which rows survive: a co-parent's request that fell through
 * to the family sweep would stamp the children's entire history for deletion on the say-so
 * of the parent who is leaving.
 */

const NOW = new Date('2026-10-01T08:30:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

let households = 0;

async function seedTwoParentFamily() {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [parent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `google_primary_${households}` })
    .returning({ id: schema.users.id });
  const [partner] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:partner_${households}` })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  const coParentUserId = partner?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: parentUserId, role: 'primary_parent' },
    { familyId, userId: coParentUserId, role: 'co_parent' },
  ]);
  return { familyId, parentUserId, coParentUserId };
}

function scheduledDeletionAt(familyId: string) {
  return db.database
    .select({ at: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
}

function roles(familyId: string) {
  return db.database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
}

describe('requestErasure — one door, two answers', () => {
  it('departs a co-parent and leaves the family unscheduled', async () => {
    const family = await seedTwoParentFamily();

    const result = await requestErasure(db.database, {
      familyId: family.familyId,
      actorUserId: family.coParentUserId,
      now: NOW,
    });

    expect(result).toEqual({
      outcome: 'co_parent_departed',
      departure: {
        outcome: 'departed',
        channelRevoked: 0,
        membershipRemoved: true,
        consentWithdrawn: 0,
        threadRetained: 0,
      },
    });
    expect(await scheduledDeletionAt(family.familyId)).toEqual([{ at: null }]);
    expect(await roles(family.familyId)).toEqual([{ role: 'primary_parent' }]);
  });

  it('schedules the family when the PRIMARY parent asks — that path is unchanged', async () => {
    const family = await seedTwoParentFamily();

    const result = await requestErasure(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      now: NOW,
    });

    expect(result).toEqual({
      outcome: 'family_scheduled',
      scheduledDeletionAt: new Date(NOW.getTime() + DELETION_GRACE_MS),
    });
    expect(await scheduledDeletionAt(family.familyId)).toEqual([
      { at: new Date(NOW.getTime() + DELETION_GRACE_MS) },
    ]);
    // The co-parent keeps their seat: the family is scheduled whole, and the grace
    // window is what makes it recoverable. A per-actor departure here would not be.
    expect((await roles(family.familyId)).map((r) => r.role).sort()).toEqual([
      'co_parent',
      'primary_parent',
    ]);
  });
});
