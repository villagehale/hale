import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';
import { otherParentHoldsGoogleAccount } from './store';

/**
 * VIL-156 · rows ended BEFORE endKeys dropped the account key still carry it, in the
 * column (0203 copied it there from provider_metadata, ended rows included) and in
 * provider_metadata itself (an ended row is never synced again, so nothing overwrote
 * it). This migration takes both copies off every row that keeps no token, and the
 * provider_metadata copy off every row, since the column is its only home now. Found
 * by suffix so it survives renumbering at merge.
 */
const MIGRATION = migrationFiles().find((file) =>
  file.endsWith('_integrations_ended_google_key_cleared.sql'),
);
const ACCOUNT = 'blind-index-of-one-google-account';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function coParentIn(familyId: string, name: string) {
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `${name}@example.test`, name })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: co.id, role: 'co_parent' });
  return co.id;
}

async function insertRow(values: {
  familyId: string;
  userId: string;
  status: 'active' | 'revoked';
  enc: string | null;
  pending: string | null;
}) {
  const [row] = await db.database
    .insert(schema.integrations)
    .values({
      familyId: values.familyId,
      userId: values.userId,
      provider: 'gcal',
      status: values.status,
      oauthTokensEncrypted: values.enc,
      googleRevokePendingEncrypted: values.pending,
      googleRevokePendingSince: values.pending ? new Date('2026-11-01T00:00:00Z') : null,
      googleAccountKey: ACCOUNT,
      providerMetadata: { googleAccountKey: ACCOUNT, syncToken: 'an-old-cursor' },
    })
    .returning({ id: schema.integrations.id });
  return row?.id as string;
}

async function rowOf(id: string) {
  const [row] = await db.database
    .select({
      key: schema.integrations.googleAccountKey,
      meta: schema.integrations.providerMetadata,
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, id));
  return row;
}

describe('ended Google rows lose the account key they kept from before endKeys dropped it', () => {
  it('is in the migration chain', () => {
    expect(MIGRATION).toBeDefined();
  });

  it("a legacy ended row stops blocking the parent's own link; a live row and a pending one keep the key", async () => {
    // Ended before the fix: no token, no pending revoke, key in the column and the metadata.
    const ended = await seedFamily(db.database, 'Ended');
    const endedCo = await coParentIn(ended.familyId, 'ended-co');
    const endedRow = await insertRow({
      familyId: ended.familyId,
      userId: endedCo,
      status: 'revoked',
      enc: null,
      pending: null,
    });
    // Control: the co-parent's LIVE row on the account in another family.
    const live = await seedFamily(db.database, 'Live');
    const liveCo = await coParentIn(live.familyId, 'live-co');
    const liveRow = await insertRow({
      familyId: live.familyId,
      userId: liveCo,
      status: 'active',
      enc: 'live-ciphertext',
      pending: null,
    });
    // Control: an ended row whose revoke still waits keeps the key the cancel and erasure read.
    const waiting = await seedFamily(db.database, 'Waiting');
    const waitingCo = await coParentIn(waiting.familyId, 'waiting-co');
    const waitingRow = await insertRow({
      familyId: waiting.familyId,
      userId: waitingCo,
      status: 'revoked',
      enc: null,
      pending: 'pending-ciphertext',
    });
    const blocked = (home: { familyId: string; parentUserId: string }) =>
      otherParentHoldsGoogleAccount(db.database, {
        familyId: home.familyId,
        userId: home.parentUserId,
        accountKey: ACCOUNT,
      });
    expect(await blocked(ended)).toBe(true);

    await expect(db.applyMigration(MIGRATION as string)).resolves.toBeUndefined();

    expect(await rowOf(endedRow)).toEqual({ key: null, meta: { syncToken: 'an-old-cursor' } });
    expect(await blocked(ended)).toBe(false);
    expect(await rowOf(liveRow)).toEqual({ key: ACCOUNT, meta: { syncToken: 'an-old-cursor' } });
    expect(await blocked(live)).toBe(true);
    expect(await rowOf(waitingRow)).toEqual({
      key: ACCOUNT,
      meta: { syncToken: 'an-old-cursor' },
    });
    expect(await blocked(waiting)).toBe(true);
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION as string)).resolves.toBeUndefined();
  });
});
