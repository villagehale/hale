import { randomBytes } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  PROVIDER_SESSION_TTL_MS,
  type RemoteProfileDeleter,
  deleteProviderSession,
  loadProviderSession,
  recordBrowserUseProfile,
  storeProviderSession,
  sweepExpiredProviderSessions,
} from './vault';

const CAPTURED = new Date('2026-10-20T15:00:00.000Z');
const STATE = {
  cookies: [{ name: 'JSESSIONID', value: 'cookie-secret-fixture', domain: '.perfectmind.com' }],
  origins: [],
};

describe('provider session vault', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });

  async function stored(host = 'cityofvaughan.perfectmind.com') {
    const family = await seedFamily(db.database);
    const result = await storeProviderSession(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      providerHost: host,
      storageState: STATE,
      capturedAt: CAPTURED,
    });
    if (!result.ok) throw new Error(result.reason);
    return { family, result };
  }

  it('stores the session encrypted with a 48 hour stamp and reads it back', async () => {
    const { family, result } = await stored('www.Example-Rec.test');
    const [row] = await db.database
      .select()
      .from(schema.providerSignupSessions)
      .where(eq(schema.providerSignupSessions.id, result.id));
    expect(row?.providerHost).toBe('www.example-rec.test');
    expect(row?.storageStateCiphertext).not.toContain('cookie-secret-fixture');
    expect(row?.expiresAt.getTime()).toBe(CAPTURED.getTime() + PROVIDER_SESSION_TTL_MS);

    const loaded = await loadProviderSession(db.database, {
      familyId: family.familyId,
      providerHost: 'WWW.example-rec.test',
      now: new Date(CAPTURED.getTime() + 60_000),
    });
    expect(loaded?.storageState.cookies[0]?.value).toBe('cookie-secret-fixture');
    expect(loaded?.browserUseProfileId).toBeNull();
  });

  it('does not hand out a session past 48 hours', async () => {
    const { family } = await stored();
    const loaded = await loadProviderSession(db.database, {
      familyId: family.familyId,
      providerHost: 'cityofvaughan.perfectmind.com',
      now: new Date(CAPTURED.getTime() + PROVIDER_SESSION_TTL_MS),
    });
    expect(loaded).toBeNull();
  });

  it('refuses a state that carries a password', async () => {
    const family = await seedFamily(db.database);
    const result = await storeProviderSession(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      providerHost: 'example-rec.test',
      storageState: { cookies: [{ name: 'password', value: 'x', domain: 'example-rec.test' }] },
      capturedAt: CAPTURED,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_state' });
  });

  it("deletes the row and its remote profile once the parent says they're in", async () => {
    const { family, result } = await stored();
    await recordBrowserUseProfile(db.database, { sessionRowId: result.id, profileId: 'bu-p1' });
    const deleted: string[] = [];
    const remote: RemoteProfileDeleter = {
      kind: 'api',
      deleteProfile: async (id) => {
        deleted.push(id);
      },
    };
    const outcome = await deleteProviderSession(
      db.database,
      { familyId: family.familyId, providerHost: 'cityofvaughan.perfectmind.com' },
      remote,
    );
    expect(outcome).toBe('deleted');
    expect(deleted).toEqual(['bu-p1']);
    const rows = await db.database
      .select()
      .from(schema.providerSignupSessions)
      .where(eq(schema.providerSignupSessions.id, result.id));
    expect(rows).toHaveLength(0);
  });

  it('sweeps expired rows, and keeps a row whose remote profile it cannot delete yet', async () => {
    await db.database.delete(schema.providerSignupSessions);
    const plain = await stored('plain.example.test');
    const seeded = await stored('seeded.example.test');
    const failing = await stored('failing.example.test');
    await recordBrowserUseProfile(db.database, {
      sessionRowId: seeded.result.id,
      profileId: 'bu-seeded',
    });
    await recordBrowserUseProfile(db.database, {
      sessionRowId: failing.result.id,
      profileId: 'bu-failing',
    });
    const fresh = await storeProviderSession(db.database, {
      familyId: plain.family.familyId,
      parentUserId: plain.family.parentUserId,
      providerHost: 'fresh.example.test',
      storageState: STATE,
      capturedAt: new Date(CAPTURED.getTime() + PROVIDER_SESSION_TTL_MS),
    });
    expect(fresh.ok).toBe(true);
    const after = new Date(CAPTURED.getTime() + PROVIDER_SESSION_TTL_MS + 1);

    const offline = await sweepExpiredProviderSessions(db.database, after, {
      kind: 'not_configured',
    });
    expect(offline).toEqual({ deleted: 1, remotePending: 2, remoteFailed: 0 });

    const online = await sweepExpiredProviderSessions(db.database, after, {
      kind: 'api',
      deleteProfile: async (id) => {
        if (id === 'bu-failing') throw new Error('502');
      },
    });
    expect(online).toEqual({ deleted: 1, remotePending: 0, remoteFailed: 1 });
    const left = await db.database
      .select({ host: schema.providerSignupSessions.providerHost })
      .from(schema.providerSignupSessions);
    expect(left.map((row) => row.host).sort()).toEqual([
      'failing.example.test',
      'fresh.example.test',
    ]);
  });
});
