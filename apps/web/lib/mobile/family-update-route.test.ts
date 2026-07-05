import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Family WRITE route only gates (auth) and DISPATCHES to the SAME web
// server actions the browser Family/Settings pages call — it owns no validation
// or DB access of its own (rule #1). So we mock those actions to assert the exact
// delegation + the action-result → HTTP-status mapping, and poison createDb to
// prove the route never constructs a db.
const authMock = vi.fn();
const editChildMock = vi.fn();
const setLocationMock = vi.fn();
const setParentNameMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/family/children-actions', () => ({
  editChildAction: (...a: unknown[]) => editChildMock(...a),
  setLocationAction: (...a: unknown[]) => setLocationMock(...a),
  setParentNameAction: (...a: unknown[]) => setParentNameMock(...a),
}));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyMembers: vi.fn(),
  loadFamilyBasics: vi.fn(),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile family update route must NOT construct its own db (rule #1)');
    },
  };
});

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/family/route');
  return POST(
    new Request('http://localhost/api/mobile/family', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/family', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    editChildMock.mockReset();
    setLocationMock.mockReset();
    setParentNameMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never dispatches', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ action: 'setParentName', name: 'Ada' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(setParentNameMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a body with no action', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ name: 'Ada' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('delegates editChild to editChildAction with the childId and fields, and maps updated → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    editChildMock.mockResolvedValue({ status: 'updated' });

    const res = await callPost({
      action: 'editChild',
      childId: 'child-9',
      name: 'Maya',
      dateOfBirth: '2020-05-01',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'updated' });
    expect(editChildMock).toHaveBeenCalledWith('child-9', {
      name: 'Maya',
      dateOfBirth: '2020-05-01',
    });
  });

  it('surfaces a child validation error code as 400 with the code', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    editChildMock.mockResolvedValue({ status: 'invalid', error: 'dob_future' });

    const res = await callPost({
      action: 'editChild',
      childId: 'child-9',
      name: 'Maya',
      dateOfBirth: '2999-01-01',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'dob_future' });
  });

  it('delegates setLocation and maps not_found → 404', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setLocationMock.mockResolvedValue({ status: 'not_found' });

    const res = await callPost({ action: 'setLocation', city: 'Toronto', postalCode: 'M5V 2T6' });

    expect(res.status).toBe(404);
    expect(setLocationMock).toHaveBeenCalledWith({
      country: undefined,
      province: undefined,
      city: 'Toronto',
      postalCode: 'M5V 2T6',
    });
  });

  it('maps a preview outcome (auth unconfigured) to 503', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    setParentNameMock.mockResolvedValue({ status: 'preview' });

    const res = await callPost({ action: 'setParentName', name: 'Ada' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'preview' });
  });
});
