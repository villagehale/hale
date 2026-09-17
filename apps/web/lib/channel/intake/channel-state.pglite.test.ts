import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { findReenrollableChannelOwner, findRevokedChannelOwner } from './channel-state';

/**
 * VIL-355 · one revoked `parent_channels` row, two different questions.
 *
 * "Is this number unsubscribed?" is number-keyed and membership-blind, and must stay
 * that way — every proactive send checks it, and a departed co-parent's number is the
 * last one Hale should decide it may text again. "Which household does this number
 * re-enter on START?" is a different question, and answering it from the same row was
 * the bug: departure revokes the seat AND the channel, so the revoked row kept naming
 * a family the person had left, and START re-enrolled them into it.
 *
 * Against the real DDL because the whole claim is which rows the scoping sees.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-10-01T08:30:00.000Z');

let db: TestDb;

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

async function seedRevokedChannel(seated: boolean): Promise<{
  familyId: string;
  userId: string;
}> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:left-the-family' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  if (seated) {
    await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'co_parent' });
  }
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
    revokedAt: NOW,
  });
  return { familyId, userId };
}

describe('findReenrollableChannelOwner — START may only re-enter a seat that still exists', () => {
  it('hands back the owner while the seat stands', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });

  it('hands back nothing once the seat is gone — the number is a stranger again', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);
    await db.database
      .delete(schema.familyMembers)
      .where(
        and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
      );

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toBeNull();
    // …while the SUPPRESSION answer is unchanged: the number still said STOP, and the
    // proactive senders that read this must keep skipping it.
    expect(await findRevokedChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });

  it('does not accept a seat the person holds in some OTHER household', async () => {
    const { familyId, userId } = await seedRevokedChannel(false);
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other household', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other?.id as string, userId, role: 'co_parent' });

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toBeNull();
    expect(await findRevokedChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });
});
