import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Settings route gates (auth) and delegates the ONE notification
// preference (the daily brief email, a CASL opt-out) to the shared lib, which owns
// the DB read/write + the audit row (rules #1/#6). We mock the lib to assert the
// delegation + the result → HTTP-status mapping, and poison createDb to prove the
// route never touches the db itself.
const authMock = vi.fn();
const loadPrefsMock = vi.fn();
const setPrefMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/settings/notification-prefs', () => ({
  loadNotificationPrefs: () => loadPrefsMock(),
  setNotificationPrefAction: (...a: unknown[]) => setPrefMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile settings route must NOT construct its own db (rule #1)');
    },
  };
});

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/settings/route');
  return GET();
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/settings/route');
  return POST(
    new Request('http://localhost/api/mobile/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/mobile/settings', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadPrefsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never reads prefs', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadPrefsMock).not.toHaveBeenCalled();
  });

  it('returns the notification prefs for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadPrefsMock.mockResolvedValue({ status: 'ready', prefs: { dailyBriefEmail: false } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: { dailyBriefEmail: false } });
  });
});

describe('POST /api/mobile/settings', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    setPrefMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ pref: 'dailyBriefEmail', enabled: false });

    expect(res.status).toBe(401);
    expect(setPrefMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown pref with 400 and never writes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ pref: 'villageUpdates', enabled: true });

    expect(res.status).toBe(400);
    expect(setPrefMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean enabled with 400', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ pref: 'dailyBriefEmail', enabled: 'yes' });

    expect(res.status).toBe(400);
    expect(setPrefMock).not.toHaveBeenCalled();
  });

  it('delegates a valid toggle and maps updated → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setPrefMock.mockResolvedValue({ status: 'updated' });

    const res = await callPost({ pref: 'dailyBriefEmail', enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'updated' });
    expect(setPrefMock).toHaveBeenCalledWith('dailyBriefEmail', false);
  });
});
