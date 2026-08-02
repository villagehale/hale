import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';

/**
 * VIL-260 · WS3 — WHICH PARENT approved this?
 *
 * The approve/decline routes stamped the caller's EXTERNAL Auth.js id onto the
 * consent record. Nothing in the family owns that id: `family_members.user_id` holds
 * the INTERNAL `users.id`, so the trail's actor resolver found no member and
 * attributed the parent's own decision to Hale — on the History timeline AND in the
 * PIPEDA right-to-access export, which is the record that has to answer "who
 * consented to this" (rules #5, #6).
 *
 * Two halves, asserted together: the route must WRITE the internal id, and the
 * resolver must READ that id back as the parent. The second half is what makes the
 * first one matter, so it runs against the real loadTrailForFamily.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_AUTH_ID = 'auth0|external-9f3';
const INTERNAL_USER_ID = '22222222-2222-4222-8222-222222222222';
const VALID_ID = '33333333-3333-4333-8333-333333333333';

const authMock = vi.fn();
const approveMock = vi.fn();
const declineMock = vi.fn();

// `after()` only runs inside a real request scope; the drain kick is not what this
// test is about, so it is a no-op here.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => void) => void fn,
}));
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: vi.fn() }) }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: vi.fn() }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => FAMILY_ID),
  resolveUserIdForUser: vi.fn(async () => INTERNAL_USER_ID),
}));
vi.mock('~/lib/actions/approve', () => ({
  approveDraftedAction: (...a: unknown[]) => approveMock(...a),
}));
vi.mock('~/lib/actions/decline', () => ({
  declineDraftedAction: (...a: unknown[]) => declineMock(...a),
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function configureAuth() {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'gid_test');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'gsecret_test');
}

describe('approve/decline record the INTERNAL user id as the audit actor', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    approveMock.mockReset();
    declineMock.mockReset();
    authMock.mockResolvedValue({ user: { id: EXTERNAL_AUTH_ID } });
    approveMock.mockResolvedValue({ status: 202, payload: {} });
    declineMock.mockResolvedValue({ status: 200 });
    configureAuth();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('approve stamps approvedBy with the internal users.id, not the external auth id', async () => {
    const { POST } = await import('~/app/api/actions/[id]/approve/route');
    await POST(
      new Request('http://localhost/api/actions/x/approve', { method: 'POST' }),
      ctx(VALID_ID),
    );

    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(approveMock.mock.calls[0]?.[2]).toMatchObject({ approvedBy: INTERNAL_USER_ID });
  });

  it('decline stamps declinedBy with the internal users.id, not the external auth id', async () => {
    const { POST } = await import('~/app/api/actions/[id]/decline/route');
    await POST(
      new Request('http://localhost/api/actions/x/decline', { method: 'POST' }),
      ctx(VALID_ID),
    );

    expect(declineMock).toHaveBeenCalledTimes(1);
    expect(declineMock.mock.calls[0]?.[1]).toMatchObject({ declinedBy: INTERNAL_USER_ID });
  });

  it('refuses to approve a caller with no internal user row rather than writing a wrong actor', async () => {
    const family = await import('~/lib/family');
    vi.mocked(family.resolveUserIdForUser).mockResolvedValueOnce(null);

    const { POST } = await import('~/app/api/actions/[id]/approve/route');
    const res = await POST(
      new Request('http://localhost/api/actions/x/approve', { method: 'POST' }),
      ctx(VALID_ID),
    );

    expect(res.status).toBe(403);
    expect(approveMock).not.toHaveBeenCalled();
  });
});

/** The audit trail rows both halves are judged against. */
function auditRow(actor: string) {
  return {
    entry: {
      id: `log-${actor}`,
      familyId: FAMILY_ID,
      actor,
      actionTaken: 'action.approved_by_human',
      targetTable: 'actions',
      targetId: 'act-1',
      before: null,
      after: null,
      occurredAt: new Date('2026-07-28T14:00:00Z'),
      ip: null,
      userAgent: null,
      agentRunId: null,
    },
    teenContent: null,
    childId: null,
    childDob: null,
    childName: null,
  };
}

const TRAIL_ROWS = [auditRow(INTERNAL_USER_ID), auditRow(EXTERNAL_AUTH_ID)];

/** Fakes the four reads loadTrailForFamily makes: children DOBs, the primary
 * parent's timezone, the family member set (the actor resolver), and the trail. */
function trailDb() {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => [] }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
      };
    }
    if (keys.includes('userId') && keys.includes('role')) {
      return {
        from: () => ({
          where: async () => [{ userId: INTERNAL_USER_ID, role: 'primary_parent' }],
        }),
      };
    }
    const node = () =>
      Object.assign(Promise.resolve(TRAIL_ROWS), {
        limit: () => Promise.resolve(TRAIL_ROWS),
        orderBy: () => node(),
      });
    return {
      from: () => ({
        leftJoin: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => node() }) }) }),
      }),
    };
  });
  return { select } as never;
}

describe('the trail actor resolver reads the two ids differently', () => {
  it("resolves the internal users.id to 'you' and the external auth id to Hale", async () => {
    const views = await loadTrailForFamily(trailDb(), FAMILY_ID);

    // The id the routes now write: the family owns it, so the parent's own consent
    // reads as theirs.
    expect(views.find((v) => v.id === `log-${INTERNAL_USER_ID}`)?.actor).toBe('you');
    // The id they used to write: no family member owns it, so the PIPEDA record
    // credited the parent's approval to Hale. This is the defect, pinned.
    expect(views.find((v) => v.id === `log-${EXTERNAL_AUTH_ID}`)?.actor).toBe('hale');
  });
});
