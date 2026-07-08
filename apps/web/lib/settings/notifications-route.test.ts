import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile push-prefs route (GET + PATCH /api/mobile/settings/notifications):
// auth() is the 401 gate (Bearer bridged in middleware), the shared lib owns the
// DB + audit. We stub the session + lib so we assert the GATE and the DELEGATION,
// not the DB. Poison @hale/db's createDb so a route that tried to open its own
// connection would fail loudly (repo convention).

const authMock = vi.fn();
const loadMock = vi.fn();
const setMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/settings/push-notification-prefs', () => ({
  loadPushNotificationPrefs: () => loadMock(),
  setPushNotificationPref: (...a: unknown[]) => setMock(...a),
}));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('push-prefs route must NOT open its own DB connection');
    },
  };
});

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/settings/notifications/route');
  return GET();
}

async function callPatch(body: unknown): Promise<Response> {
  const { PATCH } = await import('~/app/api/mobile/settings/notifications/route');
  return PATCH(
    new Request('http://localhost/api/mobile/settings/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/mobile/settings/notifications', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadMock.mockReset();
    setMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns 401 and never reads prefs when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('returns the two push booleans for a signed-in caller', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadMock.mockResolvedValue({
      status: 'ready',
      prefs: { pushNewPicks: false, pushHealthReminders: true },
    });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notifications: { pushNewPicks: false, pushHealthReminders: true },
    });
  });
});

describe('PATCH /api/mobile/settings/notifications', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadMock.mockReset();
    setMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns 401 and never writes when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callPatch({ pref: 'pushNewPicks', enabled: false });

    expect(res.status).toBe(401);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown pref with 400 and never writes', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callPatch({ pref: 'dailyBriefEmail', enabled: false });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean enabled with 400', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callPatch({ pref: 'pushHealthReminders', enabled: 'yes' });

    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('delegates a valid toggle to the shared lib (user-scoped inside it)', async () => {
    authMock.mockResolvedValue(session('google-1'));
    setMock.mockResolvedValue({ status: 'updated' });

    const res = await callPatch({ pref: 'pushHealthReminders', enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'updated' });
    expect(setMock).toHaveBeenCalledWith('pushHealthReminders', false);
  });
});
