import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/rights/delete — the confirm-gated account/family deletion REQUEST
 * (PIPEDA/Law 25 right-to-erasure). Auth mirrors the share route: dev-preview 501,
 * signed-out 401, no-family/no-user 403. A request MISSING the confirmation is 400
 * (nothing scheduled). A confirmed request calls the AUDITED scheduler (which
 * SCHEDULES, never hard-deletes) and returns 202 with the effective deletion date.
 */

const authMock = vi.fn();
const listSeatsMock = vi.fn();
const resolveUserIdMock = vi.fn();
const erasureMock = vi.fn();
const tellStayingParentMock = vi.fn();
const departureNoticePortsMock = vi.fn();
const DB_HANDLE = { __db: true };
const NOTICE_PORTS = { __ports: true };
const SCHEDULED_AT = new Date('2026-07-10T12:00:00.000Z');

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  listSeatsForUser: (...a: unknown[]) => listSeatsMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('./delete', () => ({
  requestErasure: (...a: unknown[]) => erasureMock(...a),
}));
// Mocked so the CALL ITSELF is assertable. Without these two the route could stop
// telling the staying parent entirely and every test here would still pass — the
// departure notice's own suite drives the function directly, and this route is its only
// production caller (the house rule: pin the wiring, not just the unit).
vi.mock('~/lib/channel/coparent/departure-notice', () => ({
  tellStayingParent: (...a: unknown[]) => tellStayingParentMock(...a),
}));
vi.mock('~/lib/channel/twilio/deps', () => ({
  departureNoticePorts: (...a: unknown[]) => departureNoticePortsMock(...a),
}));

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callDelete(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/rights/delete/route');
  return POST(
    new Request('http://localhost/api/rights/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/rights/delete', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    listSeatsMock.mockReset();
    resolveUserIdMock.mockReset();
    erasureMock.mockReset();
    tellStayingParentMock.mockReset().mockResolvedValue('sent');
    departureNoticePortsMock.mockReset().mockReturnValue(NOTICE_PORTS);
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role: 'primary_parent' }]);
    resolveUserIdMock.mockResolvedValue('user-1');
    erasureMock.mockResolvedValue({
      outcome: 'family_scheduled',
      scheduledDeletionAt: SCHEDULED_AT,
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never schedules unauthenticated', async () => {
    configureAuth(false);
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(erasureMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(401);
    expect(erasureMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no family', async () => {
    listSeatsMock.mockResolvedValue([]);
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(403);
    expect(erasureMock).not.toHaveBeenCalled();
  });

  it('is confirm-gated: a request without confirm:true is 400 and NEVER erases', async () => {
    const res = await callDelete({ confirm: false });
    expect(res.status).toBe(400);
    expect(erasureMock).not.toHaveBeenCalled();
  });

  it('a confirmed request calls the audited scheduler and returns 202 with the deletion date', async () => {
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(202);
    expect(erasureMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: 'fam-1',
      actorUserId: 'user-1',
    });
    expect(await res.json()).toEqual({
      status: 'scheduled',
      scheduledDeletionAt: SCHEDULED_AT.toISOString(),
    });
    // Nobody is told anything: a scheduled family has not lost a co-parent.
    expect(tellStayingParentMock).not.toHaveBeenCalled();
  });

  // VIL-355 · the departing co-parent's answer says what was undone and names no
  // deletion date, because nothing of the household's was scheduled. A response that
  // reused 'scheduled' would tell them their family's record is going too.
  it('answers a departing co-parent with the tally and NO deletion date', async () => {
    erasureMock.mockResolvedValue({
      outcome: 'co_parent_departed',
      departure: {
        outcome: 'departed',
        channelRevoked: 1,
        mcpGrantsRevoked: 2,
        connectorsRevoked: 1,
        teenGrantsRevoked: 1,
        membershipRemoved: true,
        consentWithdrawn: 1,
        threadRetained: 1,
        channelRecordRetained: 1,
        inviteRecordRetained: 1,
        identityRetained: true,
      },
    });

    const res = await callDelete({ confirm: true });

    expect(res.status).toBe(202);
    // THE WIRING, pinned: this route is the only production caller of the notice, so
    // without this assertion deleting the call ships a silent regression.
    expect(departureNoticePortsMock).toHaveBeenCalledWith(DB_HANDLE);
    expect(tellStayingParentMock).toHaveBeenCalledTimes(1);
    expect(tellStayingParentMock).toHaveBeenCalledWith(
      DB_HANDLE,
      { familyId: 'fam-1', departedUserId: 'user-1', now: expect.any(Date) },
      NOTICE_PORTS,
    );
    // Every line of the tally reaches the person who asked — what ended AND what was
    // kept. A body that named only the revocations would answer an erasure request by
    // listing the good news (rule #11).
    expect(await res.json()).toEqual({
      status: 'departed',
      channelRevoked: 1,
      mcpGrantsRevoked: 2,
      connectorsRevoked: 1,
      teenGrantsRevoked: 1,
      membershipRemoved: true,
      consentWithdrawn: 1,
      threadRetained: 1,
      channelRecordRetained: 1,
      inviteRecordRetained: 1,
      identityRetained: true,
    });
  });

  /**
   * The erasure has already COMMITTED when the notice is attempted, so a transport that
   * throws may not turn into a 500: that would tell somebody their request failed when
   * it did not, and their retry would be refused for want of a seat.
   */
  it('still answers the departing co-parent 202 when the staying parent cannot be told', async () => {
    erasureMock.mockResolvedValue({
      outcome: 'co_parent_departed',
      departure: { outcome: 'departed', membershipRemoved: true },
    });
    tellStayingParentMock.mockRejectedValue(new Error('twilio down'));

    const res = await callDelete({ confirm: true });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'departed', membershipRemoved: true });
    expect(tellStayingParentMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A separated parent is primary_parent of one household and co_parent of another.
   * `resolveFamilyForUser` is `limit(1)` with no ORDER BY, so the SAME click either
   * scheduled their own children's deletion or departed the other family, decided by
   * heap order. An irreversible act may not inherit an arbitrary pick: the route asks
   * which household before it does anything.
   */
  it('refuses a caller seated in more than one household rather than picking one', async () => {
    listSeatsMock.mockResolvedValue([
      { familyId: 'fam-1', role: 'primary_parent' },
      { familyId: 'fam-2', role: 'co_parent' },
    ]);

    const res = await callDelete({ confirm: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'multiple_families' });
    expect(erasureMock).not.toHaveBeenCalled();
  });

  it('answers a scoped seat 403 — a caregiver cannot schedule the household’s erasure', async () => {
    listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role: 'babysitter' }]);
    erasureMock.mockResolvedValue({ outcome: 'not_permitted', role: 'babysitter' });

    const res = await callDelete({ confirm: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_permitted' });
  });
});
