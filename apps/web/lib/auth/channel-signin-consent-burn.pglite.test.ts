import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CHANNEL_SIGNIN_TTL_MS,
  consumeChannelSigninTokenById,
  mintChannelSigninTokens,
} from './channel-signin';

/**
 * VIL-721 · the one Google link's state is single-use because its texted link is spent
 * before the code is exchanged. A consent that began on a live link can return after the
 * link's own life, so that spend holds for an expired row, and still only once.
 */
const NOW = new Date('2026-11-23T15:00:00.000Z');
const AFTER_EXPIRY = new Date(NOW.getTime() + CHANNEL_SIGNIN_TTL_MS + 60_000);

describe('consumeChannelSigninTokenById on a consent that outlived its link', () => {
  let db: TestDb;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    ({ parentUserId: userId } = await seedFamily(db.database));
    await db.database
      .update(schema.users)
      .set({ externalAuthId: 'sms:consent-burn' })
      .where(eq(schema.users.id, userId));
  });

  afterAll(async () => {
    await db.close();
  });

  it('refuses an expired link by default, and spends it exactly once when told to', async () => {
    const [link] = await mintChannelSigninTokens(db.database, { userId, count: 1, now: NOW });
    if (!link) throw new Error('expected a token');
    const input = { tokenId: link.tokenId, userId, now: AFTER_EXPIRY };

    expect(await consumeChannelSigninTokenById(db.database, input)).toEqual({
      ok: false,
      reason: 'spent',
    });
    expect(
      await consumeChannelSigninTokenById(db.database, { ...input, ignoreExpiry: true }),
    ).toEqual({ ok: true });
    expect(
      await consumeChannelSigninTokenById(db.database, { ...input, ignoreExpiry: true }),
    ).toEqual({ ok: false, reason: 'spent' });
  });
});
