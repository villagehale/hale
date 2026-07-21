import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The register route ties a device's Expo push token to the signed-in user. We
// stub the auth session (the 401 gate) and the family lookup (external id →
// users.id), and drive a capturing fake db so we assert the upsert args WITHOUT a
// real DB. Rule #1: the token is a device address; the route must never log it,
// so no test asserts a token in a log.
const authMock = vi.fn();
const resolveUserIdMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/family', () => ({
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));

interface Capture {
  pushTokens: unknown[];
  conflict: unknown[];
  deleted: unknown[];
}
let capture: Capture;

// The db handle the route writes through. `insert(...).values(...).onConflictDoUpdate(...)`
// captures the row + conflict clause; `delete(...).where(...)` captures the sign-out
// delete so the test asserts the upsert target and that a delete is issued.
function fakeDb(cap: Capture): unknown {
  return {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === schema.pushTokens) cap.pushTokens.push(values);
        return {
          onConflictDoUpdate: async (clause: unknown) => {
            cap.conflict.push(clause);
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (predicate: unknown) => {
        if (table === schema.pushTokens) cap.deleted.push(predicate);
      },
    }),
  };
}

vi.mock('~/lib/db', () => ({ db: () => fakeDb(capture) }));

// Poison the real connection factory (repo convention): the route must go through
// the `db()` indirection, never construct its own handle against a live DB.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('push register route must NOT open its own DB connection');
    },
  };
});

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/push/register/route');
  return POST(
    new Request('http://localhost/api/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function callDelete(body: unknown): Promise<Response> {
  const { DELETE } = await import('~/app/api/push/register/route');
  return DELETE(
    new Request('http://localhost/api/push/register', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const VALID_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

describe('POST /api/push/register', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    resolveUserIdMock.mockReset();
    capture = { pushTokens: [], conflict: [], deleted: [] };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 and never writes when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callPost({ expoPushToken: VALID_TOKEN, platform: 'ios' });

    expect(res.status).toBe(401);
    expect(resolveUserIdMock).not.toHaveBeenCalled();
    expect(capture.pushTokens).toEqual([]);
  });

  it('returns 400 on a token that is not a plausible Expo token', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callPost({ expoPushToken: 'not-a-real-token', platform: 'ios' });

    expect(res.status).toBe(400);
    expect(capture.pushTokens).toEqual([]);
  });

  it('upserts the token against the resolved user id (conflict on the token)', async () => {
    authMock.mockResolvedValue(session('google-1'));
    resolveUserIdMock.mockResolvedValue('user-1');

    const res = await callPost({ expoPushToken: VALID_TOKEN, platform: 'ios' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Keyed to the resolved internal user id, not the external session id.
    expect(resolveUserIdMock).toHaveBeenCalledWith('google-1', expect.anything());
    expect(capture.pushTokens).toHaveLength(1);
    expect(capture.pushTokens[0]).toMatchObject({
      userId: 'user-1',
      expoPushToken: VALID_TOKEN,
      platform: 'ios',
    });
    // Conflict on the unique token re-points it to the current user + bumps last_seen_at.
    const clause = capture.conflict[0] as { target: unknown; set: Record<string, unknown> };
    expect(clause.target).toBe(schema.pushTokens.expoPushToken);
    expect(clause.set).toHaveProperty('userId', 'user-1');
    expect(clause.set).toHaveProperty('lastSeenAt');
  });

  it('returns 403 when the signed-in user has no mirrored users row yet', async () => {
    authMock.mockResolvedValue(session('google-1'));
    resolveUserIdMock.mockResolvedValue(null);

    const res = await callPost({ expoPushToken: VALID_TOKEN, platform: 'ios' });

    expect(res.status).toBe(403);
    expect(capture.pushTokens).toEqual([]);
  });
});

describe('DELETE /api/push/register (sign-out hygiene)', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    resolveUserIdMock.mockReset();
    capture = { pushTokens: [], conflict: [], deleted: [] };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 and never deletes when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callDelete({ expoPushToken: VALID_TOKEN });

    expect(res.status).toBe(401);
    expect(resolveUserIdMock).not.toHaveBeenCalled();
    expect(capture.deleted).toEqual([]);
  });

  it('returns 400 on a token that is not a plausible Expo token', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callDelete({ expoPushToken: 'not-a-real-token' });

    expect(res.status).toBe(400);
    expect(capture.deleted).toEqual([]);
  });

  it('deletes the device token scoped to the resolved user', async () => {
    authMock.mockResolvedValue(session('google-1'));
    resolveUserIdMock.mockResolvedValue('user-1');

    const res = await callDelete({ expoPushToken: VALID_TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The delete is keyed to the resolved internal user id (scoped, not by token alone).
    expect(resolveUserIdMock).toHaveBeenCalledWith('google-1', expect.anything());
    expect(capture.deleted).toHaveLength(1);
  });

  it('returns 403 when the signed-in user has no mirrored users row', async () => {
    authMock.mockResolvedValue(session('google-1'));
    resolveUserIdMock.mockResolvedValue(null);

    const res = await callDelete({ expoPushToken: VALID_TOKEN });

    expect(res.status).toBe(403);
    expect(capture.deleted).toEqual([]);
  });
});
