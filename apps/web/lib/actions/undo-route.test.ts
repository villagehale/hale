import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-260 · WS3b — UNDO was SMS-only.
 *
 * `reverseExecutedCalendarAction` shipped with the channel router's "undo" command
 * wired to it, and its own comment says C3's undo surface imports the window constant
 * — but no HTTP route ever called it, so a parent who approved a calendar placement in
 * the app could only take it back by texting. This binds the same primitive to
 * POST /api/actions/:id/undo, with the SAME auth shape approve and decline use.
 *
 * The actor matters as much as the reversal: like approve/decline (fixed in #377),
 * undo must record the INTERNAL users.id, or the trail credits the parent's own
 * reversal to Hale (rules #5, #6).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_AUTH_ID = 'auth0|external-9f3';
const INTERNAL_USER_ID = '22222222-2222-4222-8222-222222222222';
const VALID_ID = '33333333-3333-4333-8333-333333333333';

const authMock = vi.fn();
const reverseMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => FAMILY_ID),
  resolveUserIdForUser: vi.fn(async () => INTERNAL_USER_ID),
}));
vi.mock('~/lib/actions/reverse-calendar', () => ({
  reverseExecutedCalendarAction: (...a: unknown[]) => reverseMock(...a),
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function callPost(id: string) {
  const { POST } = await import('~/app/api/actions/[id]/undo/route');
  return POST(new Request('http://localhost/api/actions/x/undo', { method: 'POST' }), ctx(id));
}

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

describe('POST /api/actions/:id/undo', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    reverseMock.mockReset();
    authMock.mockResolvedValue({ user: { id: EXTERNAL_AUTH_ID } });
    reverseMock.mockResolvedValue({ status: 200, familyEventId: 'fe-1' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reverses through the SAME primitive the SMS undo uses, stamping the internal user id', async () => {
    configureAuth(true);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(200);
    expect(reverseMock).toHaveBeenCalledTimes(1);
    expect(reverseMock.mock.calls[0]?.[1]).toMatchObject({
      actionId: VALID_ID,
      familyId: FAMILY_ID,
      revertedBy: INTERNAL_USER_ID,
    });
  });

  it('passes the primitive’s refusal straight through rather than inventing a reason', async () => {
    configureAuth(true);
    reverseMock.mockResolvedValue({ status: 409, error: 'undo_window_expired' });

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'undo_window_expired' });
  });

  it('never reverses for an unauthenticated caller (rule #4)', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(null);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(401);
    expect(reverseMock).not.toHaveBeenCalled();
  });

  it('refuses in dev preview, where a family can only be guessed', async () => {
    configureAuth(false);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(reverseMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id before any auth work', async () => {
    configureAuth(true);

    const res = await callPost('not-a-uuid');

    expect(res.status).toBe(400);
    expect(reverseMock).not.toHaveBeenCalled();
  });

  it('refuses a caller with no internal user row rather than writing a wrong actor', async () => {
    configureAuth(true);
    const family = await import('~/lib/family');
    vi.mocked(family.resolveUserIdForUser).mockResolvedValueOnce(null);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(403);
    expect(reverseMock).not.toHaveBeenCalled();
  });
});
