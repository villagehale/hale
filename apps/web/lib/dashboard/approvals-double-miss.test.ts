import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rule #1 DOUBLE-MISS at the Approvals query layer (end-to-end over a fake db). A
 * drafted action whose event has BOTH teen_content=false (classifier miss) AND
 * childId=null (unattributed / family-wide) has no DOB to derive from — without the
 * family fallback it would surface a teen-quoting raw payload. loadPendingApprovals
 * must compute familyHasTeen and redact when the family has a teen, while a teen-less
 * family still sees the draft (no over-redaction).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_DOB = '2011-01-01'; // ~15y → teenager
const TODDLER_DOB = '2024-05-01'; // ~2y → toddler
const TEEN_QUOTE = 'Maya said she is failing math, do not tell dad';

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => FAMILY_ID }));

// The unattributed, unflagged drafted action — the double-miss row.
const APPROVAL_ROW = {
  id: '99999999-9999-4999-8999-999999999999',
  actionType: 'reply_to_email',
  payload: { to: 'teacher@example.com', subject: 'about Maya', body: TEEN_QUOTE },
  reviewerVerdict: 'approved',
  draftedAt: new Date('2026-06-20T10:00:00Z'),
  teenContent: false,
  childId: null,
  childName: null,
  childDob: null,
};

/** Fake db. The children DOB read (familyHasTeenager) returns `childrenDob`; the
 * approvals join returns the single double-miss row. Routes by projection keys. */
function fakeDb(childrenDob: Array<{ dateOfBirth: string }>) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    // familyHasTeenager: select({ dateOfBirth }) from children.
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => childrenDob }) };
    }
    // The time layer's primary-parent timezone read (loadFamilyTimezone).
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        }),
      };
    }
    // loadPendingApprovals join.
    const node = () =>
      Object.assign(Promise.resolve([APPROVAL_ROW]), {
        limit: () => Promise.resolve([APPROVAL_ROW]),
        orderBy: () => node(),
      });
    return {
      from: () => ({
        innerJoin: () => ({ leftJoin: () => ({ where: () => node() }) }),
      }),
    };
  });
  return { select } as never;
}

let currentChildrenDob: Array<{ dateOfBirth: string }> = [];
vi.mock('~/lib/db', () => ({ db: () => fakeDb(currentChildrenDob) }));

const { loadPendingApprovals } = await import('./queries');

describe('loadPendingApprovals — rule #1 double-miss family fallback', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test';
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
  });

  it('redacts an unattributed, unflagged draft when the family has a teen (no raw payload leaks)', async () => {
    currentChildrenDob = [{ dateOfBirth: TEEN_DOB }, { dateOfBirth: TODDLER_DOB }];
    const views = await loadPendingApprovals();
    expect(views).toHaveLength(1);
    expect(views[0]?.payload).toBeNull();
    expect(JSON.stringify(views[0])).not.toContain('Maya');
    expect(JSON.stringify(views[0])).not.toContain(TEEN_QUOTE);
  });

  it('surfaces the same draft when the family has NO teen (no over-redaction)', async () => {
    currentChildrenDob = [{ dateOfBirth: TODDLER_DOB }];
    const views = await loadPendingApprovals();
    expect(views).toHaveLength(1);
    expect(views[0]?.payload).not.toBeNull();
    expect(views[0]?.preview).toContain('teacher@example.com');
  });
});
