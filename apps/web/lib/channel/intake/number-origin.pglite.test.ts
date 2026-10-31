import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { numberOriginFact, readNumberOrigin } from './number-origin';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

async function addMember(familyId: string, invitedBy: string | null, name: string | null) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `m-${Math.random()}@example.test`, name })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('no user');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent', invitedByUserId: invitedBy });
  return user.id;
}

async function intake(userId: string, familyId: string, sourceCode: string | null) {
  await db.database.insert(schema.smsIntakeSessions).values({
    phoneHash: `h-${userId}`,
    phoneEncrypted: 'x',
    state: 'done',
    dataEncrypted: 'x',
    sourceCode,
    familyId,
    userId,
    closedAt: new Date('2026-10-01T12:00:00Z'),
  });
}

describe('readNumberOrigin · how Hale has this number, from the record (#919)', () => {
  it('a parent added by a family member: who added them, by their confirmed name', async () => {
    const home = await seedFamily(db.database, 'Origin A');
    await db.database
      .update(schema.users)
      .set({ name: 'Priya' })
      .where(eq(schema.users.id, home.parentUserId));
    const co = await addMember(home.familyId, home.parentUserId, null);
    const origin = await readNumberOrigin(db.database, { familyId: home.familyId, userId: co });
    expect(origin).toEqual({ kind: 'added_by_family', byName: 'Priya' });
    expect(numberOriginFact(origin)).toMatchObject({ who: 'Priya' });
  }, 30_000);

  it('an unnamed inviter is not invented', async () => {
    const home = await seedFamily(db.database, 'Origin B');
    await db.database
      .update(schema.users)
      .set({ name: null })
      .where(eq(schema.users.id, home.parentUserId));
    const co = await addMember(home.familyId, home.parentUserId, null);
    const origin = await readNumberOrigin(db.database, { familyId: home.familyId, userId: co });
    expect(origin).toEqual({ kind: 'added_by_family', byName: null });
    expect(numberOriginFact(origin)).not.toHaveProperty('who');
  }, 30_000);

  it('a parent who arrived by SMS intake texted first; a QR code is carried when the record has one', async () => {
    const plain = await seedFamily(db.database, 'Origin C');
    await intake(plain.parentUserId, plain.familyId, null);
    expect(
      await readNumberOrigin(db.database, { familyId: plain.familyId, userId: plain.parentUserId }),
    ).toEqual({ kind: 'texted_first', viaQr: false });

    const qr = await seedFamily(db.database, 'Origin D');
    await intake(qr.parentUserId, qr.familyId, 'MILLIKEN-POOL');
    const origin = await readNumberOrigin(db.database, {
      familyId: qr.familyId,
      userId: qr.parentUserId,
    });
    expect(origin).toEqual({ kind: 'texted_first', viaQr: true });
    expect(numberOriginFact(origin)).toHaveProperty('from');
  }, 30_000);

  it('a referral link is not a QR scan — no fictitious "you scanned a QR code"', async () => {
    const friend = await seedFamily(db.database, 'Origin R2');
    await intake(friend.parentUserId, friend.familyId, 'friend-0a1b2c3d4e5f');
    const origin = await readNumberOrigin(db.database, {
      familyId: friend.familyId,
      userId: friend.parentUserId,
    });
    expect(origin).toEqual({ kind: 'texted_first', viaQr: false });
    expect(numberOriginFact(origin)).not.toHaveProperty('from');
  }, 30_000);

  it('no record says how: null, and no fact is handed to the writer', async () => {
    const home = await seedFamily(db.database, 'Origin E');
    expect(
      await readNumberOrigin(db.database, { familyId: home.familyId, userId: home.parentUserId }),
    ).toBeNull();
    expect(numberOriginFact(null)).toBeNull();
  }, 30_000);
});
