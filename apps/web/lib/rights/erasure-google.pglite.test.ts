import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_REVOKE_URL,
  type GoogleDisconnectPorts,
  disconnectGoogle,
} from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { runDeletionSweep } from './delete';

/**
 * VIL-156 follow-up · erasing a family revokes its Google grants at Google first.
 *
 * The FK cascade deletes `integrations` rows, keys and pending tokens with them, and
 * deleting a key revokes nothing: the erased family's grant would stay live at Google.
 * Driven through runDeletionSweep's production wiring; the only fake is the network
 * (global fetch), so the revoke goes through the real revoker.
 */

let db: TestDb;
const NOW = new Date('2026-11-04T15:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

let posted: string[];

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client.apps.example');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret');
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url !== GOOGLE_REVOKE_URL) throw new Error(`unexpected fetch ${url}`);
    posted.push(new URLSearchParams(init?.body ?? '').get('token') ?? '');
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

async function household(name: string) {
  const family = await seedFamily(db.database, name);
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: family.familyId, userId: co.id, role: 'co_parent' });
  return { familyId: family.familyId, parentUserId: family.parentUserId, coParentUserId: co.id };
}

async function connect(
  familyId: string,
  userId: string,
  provider: 'gcal' | 'gmail',
  refreshToken: string,
) {
  await saveConnection(db.database, {
    familyId,
    userId,
    provider,
    scopes: [],
    tokens: { accessToken: `ya29.${refreshToken}`, refreshToken },
  });
}

const googleDown: GoogleDisconnectPorts = {
  revoker: { revoke: async () => ({ outcome: 'unavailable', status: 503 }) },
  google: {
    async request() {
      throw new Error('push is off in this suite');
    },
  },
  tokenFetch: async () => {
    throw new Error('push is off in this suite');
  },
  env: {},
  now: () => NOW,
};

describe('runDeletionSweep revokes an erased family at Google before the cascade', () => {
  it('revokes every live grant and every pending one, then erases the family', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await connect(erased.familyId, erased.parentUserId, 'gmail', '1//erased-mail');
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//erased-co');
    // An earlier disconnect Google never answered: only the pending column holds it.
    await disconnectGoogle(
      db.database,
      { familyId: erased.familyId, userId: erased.coParentUserId, via: 'settings', named: 'gcal' },
      googleDown,
    );
    const kept = await household('Kept');
    await connect(kept.familyId, kept.parentUserId, 'gcal', '1//kept-cal');
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: PAST })
      .where(eq(schema.families.id, erased.familyId));

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted.sort()).toEqual(['1//erased-cal', '1//erased-co', '1//erased-mail']);
    expect(
      await db.database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(eq(schema.families.id, erased.familyId)),
    ).toEqual([]);
    // Positive control: the household not due keeps its live connection.
    const [live] = await db.database
      .select({
        status: schema.integrations.status,
        enc: schema.integrations.oauthTokensEncrypted,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, kept.familyId));
    expect(live?.status).toBe('active');
    expect(live?.enc).not.toBeNull();
  });

  it('positive control: a sweep with no family due posts nothing to Google', async () => {
    const kept = await household('Kept');
    await connect(kept.familyId, kept.parentUserId, 'gcal', '1//kept-cal');

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(0);
    expect(posted).toEqual([]);
  });
});
