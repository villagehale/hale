import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/coach/delete — the auth-gated, family-scoped removal of Ask Hale
 * history (soft-delete, rule #6). Auth mirrors the coach route: dev-preview 501,
 * signed-out 401, no-family/no-user 403. A malformed target is 400. A target the
 * family doesn't own is 404 (the mutation returns false/null — never a cross-family
 * write). The happy paths call the AUDITED soft-delete mutations with the resolved
 * family + actor.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const softDeleteMock = vi.fn();
const eraseMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/coach/conversation-delete', () => ({
  softDeleteMessage: (...a: unknown[]) => softDeleteMock(...a),
  eraseConversation: (...a: unknown[]) => eraseMock(...a),
}));

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callDelete(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/coach/delete/route');
  return POST(
    new Request('http://localhost/api/coach/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/coach/delete', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    resolveFamilyMock.mockReset();
    resolveUserIdMock.mockReset();
    softDeleteMock.mockReset();
    eraseMock.mockReset();
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    resolveFamilyMock.mockResolvedValue('fam-1');
    resolveUserIdMock.mockResolvedValue('user-1');
    softDeleteMock.mockResolvedValue(true);
    eraseMock.mockResolvedValue(3);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never deletes unauthenticated', async () => {
    configureAuth(false);
    const res = await callDelete({ messageId: MESSAGE_ID });
    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(softDeleteMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callDelete({ messageId: MESSAGE_ID });
    expect(res.status).toBe(401);
    expect(softDeleteMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callDelete({ messageId: MESSAGE_ID });
    expect(res.status).toBe(403);
    expect(softDeleteMock).not.toHaveBeenCalled();
  });

  it('rejects a body that names neither target (400) — nothing deleted', async () => {
    const res = await callDelete({});
    expect(res.status).toBe(400);
    expect(softDeleteMock).not.toHaveBeenCalled();
    expect(eraseMock).not.toHaveBeenCalled();
  });

  it('deletes one turn via the audited, family-scoped mutation and returns 200', async () => {
    const res = await callDelete({ messageId: MESSAGE_ID });
    expect(res.status).toBe(200);
    expect(softDeleteMock).toHaveBeenCalledWith(DB_HANDLE, {
      messageId: MESSAGE_ID,
      familyId: 'fam-1',
      actorUserId: 'user-1',
    });
    expect(await res.json()).toEqual({ status: 'deleted' });
  });

  it('returns 404 when the turn is not the family’s (no cross-family write, rule #1)', async () => {
    softDeleteMock.mockResolvedValue(false);
    const res = await callDelete({ messageId: MESSAGE_ID });
    expect(res.status).toBe(404);
  });

  it('erases the whole conversation via the audited mutation and reports the count', async () => {
    const res = await callDelete({ conversationId: CONVERSATION_ID });
    expect(res.status).toBe(200);
    expect(eraseMock).toHaveBeenCalledWith(DB_HANDLE, {
      conversationId: CONVERSATION_ID,
      familyId: 'fam-1',
      actorUserId: 'user-1',
    });
    expect(await res.json()).toEqual({ status: 'erased', erasedTurns: 3 });
  });

  it('returns 404 when the conversation is not the family’s (rule #1)', async () => {
    eraseMock.mockResolvedValue(null);
    const res = await callDelete({ conversationId: CONVERSATION_ID });
    expect(res.status).toBe(404);
  });
});
