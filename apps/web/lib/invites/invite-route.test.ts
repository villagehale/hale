import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The routes read Clerk auth + db at request time. We stub those edges so the
// tests exercise the auth/consent gating (rule #5: only members invite), not the
// real infra. The pure store + service logic is covered in invite-store.test.
const authMock = vi.fn();
const currentUserMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForClerkUser: vi.fn(),
  resolveUserIdForClerkUser: vi.fn(),
  ensureUserRow: vi.fn(),
}));

/** A Clerk currentUser() stub carrying a verified primary email + full name. */
function clerkUser(email: string | null, name: string | null = 'Avery') {
  return {
    primaryEmailAddress: email ? { emailAddress: email } : null,
    fullName: name,
  };
}
vi.mock('~/lib/invites/create', () => ({ createFamilyInvite: vi.fn() }));
vi.mock('~/lib/invites/accept', () => ({ acceptFamilyInvite: vi.fn() }));

function configureClerk(on: boolean) {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', on ? 'pk_test' : '');
  vi.stubEnv('CLERK_SECRET_KEY', on ? 'sk_test' : '');
}

function postInvite() {
  return new Request('http://localhost/api/invite', { method: 'POST' });
}

async function callCreate() {
  const { POST } = await import('~/app/api/invite/route');
  return POST(postInvite());
}

async function callAccept(token: string) {
  const { POST } = await import('~/app/api/invite/[token]/accept/route');
  return POST(new Request('http://localhost/api/invite/x/accept', { method: 'POST' }), {
    params: Promise.resolve({ token }),
  });
}

describe('POST /api/invite — auth + membership gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when Clerk is unconfigured — never invites unauthenticated', async () => {
    configureClerk(false);

    const res = await callCreate();

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: null });

    const res = await callCreate();

    expect(res.status).toBe(401);
  });

  it('returns 403 when the signed-in caller is not a member of any family', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    const { resolveFamilyForClerkUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForClerkUser).mockResolvedValue(null);

    const res = await callCreate();

    expect(res.status).toBe(403);
  });

  it('returns 201 with a link built from APP_URL for a member', async () => {
    configureClerk(true);
    vi.stubEnv('APP_URL', 'https://hale.example');
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    const { resolveFamilyForClerkUser, resolveUserIdForClerkUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForClerkUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForClerkUser).mockResolvedValue('user_1');
    const { createFamilyInvite } = await import('~/lib/invites/create');
    vi.mocked(createFamilyInvite).mockResolvedValue({ token: 'tok123' });

    const res = await callCreate();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ link: 'https://hale.example/invite/tok123' });
  });
});

describe('POST /api/invite/:token/accept — auth gating + result mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    currentUserMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when Clerk is unconfigured', async () => {
    configureClerk(false);

    const res = await callAccept('tok');

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but not signed in', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: null });

    const res = await callAccept('tok');

    expect(res.status).toBe(401);
  });

  it('provisions a users row for a first-time invitee and joins them as co_parent', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_new' });
    currentUserMock.mockResolvedValue(clerkUser('invitee@example.com', 'Sam'));
    const { ensureUserRow } = await import('~/lib/family');
    // ensureUserRow creates (or resolves) the internal users row for the caller.
    vi.mocked(ensureUserRow).mockResolvedValue('user_new');
    const { acceptFamilyInvite } = await import('~/lib/invites/accept');
    vi.mocked(acceptFamilyInvite).mockResolvedValue({
      status: 'accepted',
      familyId: 'fam_inviter',
      alreadyMember: false,
    });

    const res = await callAccept('tok');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'accepted', familyId: 'fam_inviter' });
    expect(ensureUserRow).toHaveBeenCalledWith(
      { clerkUserId: 'clerk_new', email: 'invitee@example.com', name: 'Sam' },
      expect.anything(),
    );
    // Acceptance redeems against the inviter's existing family — the route never
    // creates a family; the membership role is the invite's (co_parent) default.
    // The caller's primary email is threaded so the store can gate a targeted
    // invite to its intended recipient.
    expect(vi.mocked(acceptFamilyInvite).mock.calls[0]?.[1]).toEqual({
      token: 'tok',
      userId: 'user_new',
      email: 'invitee@example.com',
    });
  });

  it('returns 403 when the signed-in caller has no primary email', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    currentUserMock.mockResolvedValue(clerkUser(null));

    const res = await callAccept('tok');

    expect(res.status).toBe(403);
  });

  it('maps expired → 410, not_found → 404, already_accepted → 409, accepted → 200', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    currentUserMock.mockResolvedValue(clerkUser('parent@example.com'));
    const { ensureUserRow } = await import('~/lib/family');
    vi.mocked(ensureUserRow).mockResolvedValue('user_1');
    const { acceptFamilyInvite } = await import('~/lib/invites/accept');
    const accept = vi.mocked(acceptFamilyInvite);

    accept.mockResolvedValueOnce({ status: 'expired' });
    expect((await callAccept('tok')).status).toBe(410);

    accept.mockResolvedValueOnce({ status: 'not_found' });
    expect((await callAccept('tok')).status).toBe(404);

    accept.mockResolvedValueOnce({ status: 'already_accepted' });
    expect((await callAccept('tok')).status).toBe(409);

    accept.mockResolvedValueOnce({ status: 'wrong_recipient' });
    expect((await callAccept('tok')).status).toBe(403);

    accept.mockResolvedValueOnce({ status: 'accepted', familyId: 'fam_1', alreadyMember: false });
    const ok = await callAccept('tok');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'accepted', familyId: 'fam_1' });
  });
});
