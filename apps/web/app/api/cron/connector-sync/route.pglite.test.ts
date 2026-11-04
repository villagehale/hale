import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_REVOKE_URL, disconnectGoogle } from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * The connector-sync route's production wiring of the pending-revoke legs (VIL-156): one
 * GET deletes a pending token past seven days and asks Google again about a younger one,
 * both BEFORE the poll sweep. Fakes sit only at the ports: Google's revoke endpoint
 * (global fetch), the poll sweep and the push renewal.
 */

const holder = vi.hoisted(() => ({
  database: null as unknown,
  atSync: null as null | { stalePending: string | null; revokePosts: number },
}));

vi.mock('~/lib/db', () => ({ db: () => holder.database }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: async () => {} }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: async () => {} }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({}) }));
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: () => {},
}));

const runConnectorSync = vi.fn();
vi.mock('~/lib/cron/connector-sync', () => ({
  connectorSyncDeps: () => ({}),
  runConnectorSync: () => runConnectorSync(),
}));
const renewDueGooglePushWatches = vi.fn();
vi.mock('~/lib/integrations/google-push-runtime', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/integrations/google-push-runtime')>()),
  renewDueGooglePushWatches: () => renewDueGooglePushWatches(),
}));

const SECRET = 'cron-fixture';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE = { accessToken: 'ya29.stale', refreshToken: '1//stale-r' };
const YOUNG = { accessToken: 'ya29.young', refreshToken: '1//young-r' };

let db: TestDb;
let familyId: string;
let staleUserId: string;
let youngUserId: string;
let revokePosts: string[];

beforeAll(async () => {
  db = await createTestDb();
  holder.database = db.database;
});

afterAll(async () => {
  await db.close();
});

async function pendingFor(userId: string): Promise<string | null> {
  const [row] = await db.database
    .select({ pending: schema.integrations.googleRevokePendingEncrypted })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.familyId, familyId), eq(schema.integrations.userId, userId)));
  if (!row) throw new Error('no integrations row');
  return row.pending;
}

/** A disconnect at `at` while Google is down: the token waits in pending from then. */
async function disconnectWhileGoogleIsDown(userId: string, at: Date): Promise<void> {
  await disconnectGoogle(
    db.database,
    { familyId, userId, via: 'settings', named: 'gcal' },
    {
      revoker: { revoke: async () => ({ outcome: 'unavailable', status: 503 }) },
      google: { request: async () => ({ ok: true, status: 204, json: async () => ({}) }) },
      tokenFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      env: {},
      now: () => at,
    },
  );
}

beforeEach(async () => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  staleUserId = family.parentUserId;
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  youngUserId = co.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: youngUserId, role: 'co_parent' });
  for (const [userId, tokens] of [
    [staleUserId, STALE],
    [youngUserId, YOUNG],
  ] as const) {
    await saveConnection(db.database, {
      familyId,
      userId,
      provider: 'gcal',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      tokens,
    });
  }
  const now = Date.now();
  await disconnectWhileGoogleIsDown(staleUserId, new Date(now - 8 * DAY_MS));
  await disconnectWhileGoogleIsDown(youngUserId, new Date(now - DAY_MS));

  revokePosts = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url !== GOOGLE_REVOKE_URL) throw new Error(`unexpected fetch ${url}`);
    revokePosts.push(new URLSearchParams(init?.body).get('token') ?? '');
    return new Response('{}', { status: 200 });
  });
  holder.atSync = null;
  runConnectorSync.mockReset().mockImplementation(async () => {
    holder.atSync = {
      stalePending: await pendingFor(staleUserId),
      revokePosts: revokePosts.length,
    };
    return { swept: 0 };
  });
  renewDueGooglePushWatches.mockReset().mockResolvedValue({ skipped: 'flag_off' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/cron/connector-sync: the revoke legs are wired, and run first', () => {
  it('deletes the seven-day-old token without asking Google, and revokes the younger one, before the sweep', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      new Request('https://hale.test/api/cron/connector-sync', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.googleRevokeExpiry).toEqual({ status: 'ok', abandoned: 1 });
    expect(body.googleRevokeRetry).toMatchObject({ status: 'ok', attempted: 1, revoked: 1 });
    // Only the younger token ever reached Google; the stale one was deleted on time alone.
    expect(revokePosts).toEqual([YOUNG.refreshToken]);
    expect(await pendingFor(staleUserId)).toBeNull();
    expect(await pendingFor(youngUserId)).toBeNull();
    // Both legs had finished when the poll sweep started.
    expect(holder.atSync).toEqual({ stalePending: null, revokePosts: 1 });
    expect(renewDueGooglePushWatches).toHaveBeenCalledTimes(1);
  });

  it('positive control: without the secret nothing runs and both tokens stay pending', async () => {
    const { GET } = await import('./route');
    const response = await GET(new Request('https://hale.test/api/cron/connector-sync'));

    expect(response.status).toBe(401);
    expect(revokePosts).toEqual([]);
    expect(await pendingFor(staleUserId)).not.toBeNull();
    expect(await pendingFor(youngUserId)).not.toBeNull();
    expect(runConnectorSync).not.toHaveBeenCalled();
  });
});
