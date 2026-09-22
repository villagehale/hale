import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { handleParentCallNameReply, holdGoogleGivenName } from './parent-call-name';

/**
 * The column and the WHERE are real here. The fake evaluates an update predicate
 * in JS; this proves `name IS NULL` and the other family's row are Postgres facts.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seed(label: string): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: label, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: null })
    .returning({ id: schema.users.id });
  if (!family || !user) throw new Error('seed returned no row');
  await db.database.insert(schema.familyMembers).values({
    familyId: family.id,
    userId: user.id,
    role: 'primary_parent',
  });
  return { familyId: family.id, userId: user.id };
}

describe('parent call name on postgres', () => {
  it('holds a given name without confirming it, refuses a phone, and yes does not touch the other family', async () => {
    const a = await seed('Household A');
    const b = await seed('Household B');
    await holdGoogleGivenName(db.database, {
      familyId: b.familyId,
      userId: b.userId,
      givenName: 'Other',
    });

    expect(
      await holdGoogleGivenName(db.database, {
        familyId: a.familyId,
        userId: a.userId,
        givenName: '+14165550100',
      }),
    ).toBe('refused');
    const [afterPhone] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    expect(afterPhone).toEqual({ name: null, googleGivenName: null });

    expect(
      await holdGoogleGivenName(db.database, {
        familyId: a.familyId,
        userId: a.userId,
        givenName: 'Bea',
      }),
    ).toBe('held');
    const [held] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    expect(held).toEqual({ name: null, googleGivenName: 'Bea' });

    await db.database.insert(schema.channelMessages).values({
      familyId: a.familyId,
      parentUserId: a.userId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: 'parent_name_confirm',
      status: 'queued',
      sentAt: new Date('2026-09-22T15:00:00.000Z'),
    });
    const yes = await handleParentCallNameReply(db.database, {
      familyId: a.familyId,
      parentUserId: a.userId,
      body: 'yes',
    });
    expect(yes.status).toBe('answered');

    const [confirmed] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    const [untouched] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, b.userId));
    expect(confirmed).toEqual({ name: 'Bea', googleGivenName: null });
    expect(untouched).toEqual({ name: null, googleGivenName: 'Other' });
  });
});
