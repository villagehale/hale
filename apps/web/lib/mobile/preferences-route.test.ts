import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Preferences route gates (auth) and delegates: GET reads via the shared
// readUserPreferences (lib owns the db, rule #1); POST validates units + weekStartDay
// at the boundary, then dispatches to the SAME setPreferencesAction the web card
// calls, which resolves the family and writes the audit row (rules #1/#6). We mock the
// lib to assert the delegation + the result → HTTP-status mapping, and poison createDb
// to prove the route never constructs a db.
const authMock = vi.fn();
const readPrefsMock = vi.fn();
const setPrefsMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/settings/user-preferences', () => ({
  readUserPreferences: (...a: unknown[]) => readPrefsMock(...a),
}));
vi.mock('~/lib/family/children-actions', () => ({
  setPreferencesAction: (...a: unknown[]) => setPrefsMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile preferences route must NOT construct its own db (rule #1)');
    },
  };
});

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/preferences/route');
  return GET();
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/preferences/route');
  return POST(
    new Request('http://localhost/api/mobile/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/mobile/preferences', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    readPrefsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never reads prefs', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(readPrefsMock).not.toHaveBeenCalled();
  });

  it('returns the parent display preferences read via the shared lib', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    readPrefsMock.mockResolvedValue({ units: 'imperial', weekStartDay: 0 });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ units: 'imperial', weekStartDay: 0 });
    expect(readPrefsMock).toHaveBeenCalledWith('ext-1');
  });
});

describe('POST /api/mobile/preferences', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    setPrefsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ units: 'metric', weekStartDay: 1 });

    expect(res.status).toBe(401);
    expect(setPrefsMock).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown units', { units: 'stones', weekStartDay: 1 }],
    ['out-of-range weekStartDay', { units: 'metric', weekStartDay: 3 }],
    ['non-numeric weekStartDay', { units: 'metric', weekStartDay: '1' }],
  ])('rejects %s with 400 and never writes', async (_label, body) => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost(body);

    expect(res.status).toBe(400);
    expect(setPrefsMock).not.toHaveBeenCalled();
  });

  it('delegates a valid update and maps updated → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setPrefsMock.mockResolvedValue({ status: 'updated' });

    const res = await callPost({ units: 'imperial', weekStartDay: 0 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'updated' });
    expect(setPrefsMock).toHaveBeenCalledWith('imperial', 0);
  });

  it('maps a preview outcome (auth unconfigured) to 503', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setPrefsMock.mockResolvedValue({ status: 'preview' });

    const res = await callPost({ units: 'metric', weekStartDay: 1 });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'preview' });
  });

  it('maps a not_found outcome (family not provisioned yet) to 404', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setPrefsMock.mockResolvedValue({ status: 'not_found' });

    const res = await callPost({ units: 'metric', weekStartDay: 1 });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
