import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { CONNECTOR_SCOPES } from './google-oauth';
import { endGoogleConnections, saveConnection } from './store';

/**
 * VIL-721 · the one consent stores one token on two rows. Ending this parent's Google
 * access ends both, on the real store, and leaves the other parent's connection alone.
 */
const NOW = new Date('2026-11-23T15:00:00.000Z');
const SCOPES = [...CONNECTOR_SCOPES.gmail, ...CONNECTOR_SCOPES.gcal];
const TOKENS = { accessToken: 'ya29.bundle-test', refreshToken: 'refresh-bundle-test' };

describe('disconnecting a one-link connection', () => {
  let db: TestDb;

  beforeAll(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('ends Gmail and the calendar together, and not the other parent’s', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const [other] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:bundle-other', name: 'Other parent' })
      .returning({ id: schema.users.id });
    const otherUserId = other?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: otherUserId, role: 'co_parent' });
    for (const provider of ['gmail', 'gcal'] as const) {
      await saveConnection(db.database, {
        familyId,
        userId: parentUserId,
        provider,
        scopes: SCOPES,
        tokens: TOKENS,
      });
    }
    await saveConnection(db.database, {
      familyId,
      userId: otherUserId,
      provider: 'gmail',
      scopes: [...CONNECTOR_SCOPES.gmail],
      tokens: { accessToken: 'ya29.other-test', refreshToken: 'refresh-other-test' },
    });

    const ended = await db.database.transaction((tx) =>
      endGoogleConnections(tx as unknown as typeof db.database, {
        familyId,
        userId: parentUserId,
        now: NOW,
      }),
    );

    expect(ended.map((row) => row.provider).sort()).toEqual(['gcal', 'gmail']);
    const mine = await db.database
      .select()
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.familyId, familyId),
          eq(schema.integrations.userId, parentUserId),
        ),
      );
    expect(mine).toHaveLength(2);
    for (const row of mine) {
      expect(row.status).not.toBe('active');
      expect(row.oauthTokensEncrypted).toBeNull();
    }
    const [theirs] = await db.database
      .select()
      .from(schema.integrations)
      .where(eq(schema.integrations.userId, otherUserId));
    expect(theirs?.status).toBe('active');
    expect(theirs?.oauthTokensEncrypted).not.toBeNull();
  });
});
