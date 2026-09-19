import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { runDeletionSweep } from './delete';
import { runOrphanUserSweep, selectOrphanedUsers } from './orphan-users';

/**
 * VIL-355 follow-up · item 3 — the account nobody can reach and nothing will ever
 * remove.
 *
 * `runDeletionSweep` only ever deleted FAMILIES and let the cascade do the rest, so a
 * `users` row with no seat left anywhere survived with its name, its address, its
 * sign-in tokens and — in the case this exists for — a LIVE verified phone channel.
 * Against the real DDL, because "no remaining seat" is an anti-join and the four
 * user-scoped tables are only user-scoped in the schema.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-16T14:12:00.000Z');

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(): Promise<string> {
  seq += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: `Household ${seq}`, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

interface SeedUser {
  userId: string;
  phone: string;
}

/** A person with a verified channel in this family, optionally seated. */
async function seedUser(
  familyId: string,
  options: { role?: 'primary_parent' | 'co_parent'; live?: boolean } = {},
): Promise<SeedUser> {
  seq += 1;
  const phone = `+1416555${6000 + seq}`;
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:orphan-${seq}`,
      email: `orphan-${seq}@example.test`,
      name: 'Sam',
    })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  if (options.role) {
    await db.database.insert(schema.familyMembers).values({ familyId, userId, role: options.role });
  }
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
    ...(options.live === false ? { revokedAt: NOW } : {}),
  });
  await db.database.insert(schema.consentRecords).values({
    userId,
    familyId,
    consentType: 'sms_service_messages',
    granted: true,
    consentScope: 'sms_origination',
    policyVersion: POLICY_VERSION,
    grantedAt: NOW,
  });
  // The four tables that hang off users.id alone, and so survive every family cascade.
  await db.database.insert(schema.loopPrefs).values({ userId });
  await db.database.insert(schema.notificationPrefs).values({ userId });
  await db.database.insert(schema.channelSigninTokens).values({
    userId,
    tokenHash: `hash-${seq}`,
    expiresAt: new Date(NOW.getTime() + 900_000),
  });
  await db.database.insert(schema.phoneVerifications).values({
    userId,
    phoneE164Encrypted: encryptString(phone),
    codeHash: `code-${seq}`,
    expiresAt: new Date(NOW.getTime() + 600_000),
  });
  return { userId, phone };
}

async function userScopedRowCount(userId: string): Promise<number> {
  const counts = await Promise.all([
    db.database.select({ userId: schema.loopPrefs.userId }).from(schema.loopPrefs),
    db.database.select({ userId: schema.notificationPrefs.userId }).from(schema.notificationPrefs),
    db.database.select({ userId: schema.channelSigninTokens.userId }).from(schema.channelSigninTokens),
    db.database.select({ userId: schema.phoneVerifications.userId }).from(schema.phoneVerifications),
  ]);
  return counts.flat().filter((r) => r.userId === userId).length;
}

async function identity(userId: string) {
  const [row] = await db.database
    .select({
      email: schema.users.email,
      name: schema.users.name,
      externalAuthId: schema.users.externalAuthId,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row;
}

describe('the orphan-user sweep', () => {
  it('closes every live door on a seatless account, and leaves a seated one alone', async () => {
    const familyId = await seedFamily();
    const seated = await seedUser(familyId, { role: 'primary_parent' });
    const orphan = await seedUser(familyId);

    expect((await selectOrphanedUsers(db.database)).map((o) => o.userId)).toEqual([orphan.userId]);
    const summary = await runOrphanUserSweep(db.database, NOW);

    expect(summary).toEqual({
      swept: 1,
      channelsRevoked: 1,
      consentWithdrawn: 1,
      scopedRowsDeleted: 4,
      identitiesAnonymised: 1,
      sweptWithoutTrail: 0,
    });
    // The orphan: no live channel, nothing user-scoped, no identity.
    const [channel] = await db.database
      .select({ revokedAt: schema.parentChannels.revokedAt })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.userId, orphan.userId));
    expect(channel?.revokedAt).toEqual(NOW);
    expect(await userScopedRowCount(orphan.userId)).toBe(0);
    expect(await identity(orphan.userId)).toEqual({
      email: null,
      name: null,
      externalAuthId: null,
    });
    // The CASL evidence is KEPT — the encrypted number is why the users row survives.
    const kept = await db.database
      .select({ id: schema.parentChannels.id })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.userId, orphan.userId));
    expect(kept).toHaveLength(1);
    // The withdrawal is APPENDED, never an update (the house ledger convention).
    const consents = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, orphan.userId));
    expect(consents.map((c) => c.granted).sort()).toEqual([false, true]);
    // Rule #6: one row per person, in the household whose channel record they hold.
    const audits = await db.database
      .select({
        actionTaken: schema.auditLog.actionTaken,
        targetId: schema.auditLog.targetId,
        familyId: schema.auditLog.familyId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'orphan_user_erased'));
    expect(audits).toEqual([
      { actionTaken: 'orphan_user_erased', targetId: orphan.userId, familyId },
    ]);

    // THE POSITIVE CONTROL: the seated parent is untouched, row for row.
    expect(await userScopedRowCount(seated.userId)).toBe(4);
    expect(await identity(seated.userId)).toMatchObject({ name: 'Sam' });
    const [seatedChannel] = await db.database
      .select({ revokedAt: schema.parentChannels.revokedAt })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.userId, seated.userId));
    expect(seatedChannel?.revokedAt).toBeNull();
  });

  it('runs to a fixed point — a second pass finds nothing left to do', async () => {
    const familyId = await seedFamily();
    await seedUser(familyId, { role: 'primary_parent' });
    await seedUser(familyId);

    await runOrphanUserSweep(db.database, NOW);
    const again = await runOrphanUserSweep(db.database, NOW);

    expect(again).toEqual({
      swept: 0,
      channelsRevoked: 0,
      consentWithdrawn: 0,
      scopedRowsDeleted: 0,
      identitiesAnonymised: 0,
      sweptWithoutTrail: 0,
    });
  });

  it('never touches an account that was never provisioned into a household', async () => {
    // A web signup with no family and no channel is not an orphan, it is a new user —
    // the predicate is "had a household and lost it", never "has no household".
    await db.database
      .insert(schema.users)
      .values({ email: 'brand-new@example.test', name: 'Jo' })
      .returning({ id: schema.users.id });

    expect(await selectOrphanedUsers(db.database)).toEqual([]);
    expect(await runOrphanUserSweep(db.database, NOW)).toMatchObject({ swept: 0 });
    const [row] = await db.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.email, 'brand-new@example.test'));
    expect(row?.email).toBe('brand-new@example.test');
  });

  it('picks up the co-parent a real departure left behind', async () => {
    const familyId = await seedFamily();
    await seedUser(familyId, { role: 'primary_parent' });
    const leaving = await seedUser(familyId, { role: 'co_parent' });

    const departure = await departCoParent(db.database, {
      familyId,
      actorUserId: leaving.userId,
      now: NOW,
    });
    expect(departure).toMatchObject({ outcome: 'departed', identityRetained: true });
    // Before the sweep, the thing depart.ts names as the gap: the row is still theirs.
    expect(await identity(leaving.userId)).toMatchObject({ name: 'Sam' });
    expect(await userScopedRowCount(leaving.userId)).toBe(4);

    const summary = await runOrphanUserSweep(db.database, NOW);

    // The departure already revoked the channel and appended the withdrawal, so those
    // two counts are zero — and that is the point of counting them separately.
    expect(summary).toEqual({
      swept: 1,
      channelsRevoked: 0,
      consentWithdrawn: 0,
      scopedRowsDeleted: 4,
      identitiesAnonymised: 1,
      // The departure left their household standing, so the audit row has a home.
      sweptWithoutTrail: 0,
    });
    expect(await identity(leaving.userId)).toEqual({
      email: null,
      name: null,
      externalAuthId: null,
    });
  });

  /**
   * The case the module's own header claims and could not reach: the household was
   * ERASED, so `parent_channels` cascaded away with it and the person who held the
   * channel became invisible to a candidate set built from channel rows. Their name,
   * their address and their sign-in identity survived the erasure they asked for.
   */
  it('reaches the parent whose household was erased on this very tick', async () => {
    const doomed = await seedFamily();
    const erased = await seedUser(doomed, { role: 'primary_parent' });
    const living = await seedFamily();
    const stays = await seedUser(living, { role: 'primary_parent' });
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: new Date(NOW.getTime() - 1_000) })
      .where(eq(schema.families.id, doomed));

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary).toMatchObject({
      erased: 1,
      orphans: {
        swept: 1,
        scopedRowsDeleted: 4,
        identitiesAnonymised: 1,
        // No household is left to hold their audit row — named, never folded into the
        // rest of the tally (rule #11). The cron logs it.
        sweptWithoutTrail: 1,
      },
    });
    expect(await identity(erased.userId)).toEqual({
      email: null,
      name: null,
      externalAuthId: null,
    });
    expect(await userScopedRowCount(erased.userId)).toBe(0);

    // THE POSITIVE CONTROL: a parent whose household was not due is untouched.
    expect(await identity(stays.userId)).toMatchObject({ name: 'Sam' });
    expect(await userScopedRowCount(stays.userId)).toBe(4);
  });

  it('is part of the lifecycle sweep, not a second cron', async () => {
    const familyId = await seedFamily();
    await seedUser(familyId, { role: 'primary_parent' });
    await seedUser(familyId);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary).toMatchObject({
      erased: 0,
      purgedObjects: 0,
      orphans: { swept: 1, identitiesAnonymised: 1 },
    });
  });
});
