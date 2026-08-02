import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-147 · the Approvals queue honours an ACTIVE teen access grant, end-to-end over
 * a fake db — and honours nothing else. This is the consume side of rule #1's named
 * exception: with no grant the row is redacted exactly as before (the byte-for-byte
 * guarantee), with an in-scope active grant the parent sees the drafted payload, and
 * an out-of-scope or inactive grant changes nothing.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';
const TEEN_DOB = '2011-01-01'; // ~15y → teenager
const TEEN_QUOTE = 'Maya said she is failing math, do not tell dad';
const NOW = new Date('2026-08-02T12:00:00.000Z');

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: async () => FAMILY_ID,
  currentUserId: async () => PARENT_ID,
}));

const APPROVAL_ROW = {
  id: '99999999-9999-4999-8999-999999999999',
  actionType: 'reply_to_email',
  payload: { to: 'teacher@example.com', subject: 'about Maya', body: TEEN_QUOTE },
  reviewerVerdict: 'approved',
  draftedAt: new Date('2026-06-20T10:00:00Z'),
  teenContent: true,
  childId: TEEN_ID,
  childName: 'Maya',
  childDob: TEEN_DOB,
};

/** An active, assented, in-window grant row as candidateGrantsQuery projects it. */
function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    childId: TEEN_ID,
    scope: 'message_content',
    teenAssentAt: new Date('2026-08-02T09:00:00.000Z'),
    startsAt: new Date('2026-08-02T09:00:00.000Z'),
    expiresAt: new Date('2026-08-05T09:00:00.000Z'),
    revokedAt: null,
    safetyEscalation: false,
    ...overrides,
  };
}

function fakeDb(grants: Array<Record<string, unknown>>) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    // familyHasTeenager: select({ dateOfBirth }) from children.
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => [{ dateOfBirth: TEEN_DOB }] }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
      };
    }
    // candidateGrantsQuery: the teen-access grant read.
    if (keys.includes('safetyEscalation') && keys.includes('scope')) {
      return { from: () => ({ where: async () => grants }) };
    }
    const node = () =>
      Object.assign(Promise.resolve([APPROVAL_ROW]), {
        limit: () => Promise.resolve([APPROVAL_ROW]),
        orderBy: () => node(),
      });
    return {
      from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => node() }) }) }),
    };
  });
  return { select } as unknown as Record<string, unknown>;
}

async function loadApprovals(grants: Array<Record<string, unknown>>) {
  vi.doMock('~/lib/db', () => ({ db: () => fakeDb(grants) }));
  const { loadPendingApprovals } = await import('./queries');
  return loadPendingApprovals();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.DATABASE_URL = 'postgres://test';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('loadPendingApprovals × teen access grants', () => {
  it('redacts the teen draft when there is NO grant (unchanged behaviour)', async () => {
    const [approval] = await loadApprovals([]);
    expect(approval?.teenRedacted).toBe(true);
    expect(approval?.payload).toBeNull();
    expect(JSON.stringify(approval)).not.toContain(TEEN_QUOTE);
  });

  it('reveals the drafted payload under an ACTIVE message_content grant', async () => {
    const [approval] = await loadApprovals([grantRow()]);
    expect(approval?.teenRedacted).toBe(false);
    expect(approval?.payload).toEqual(APPROVAL_ROW.payload);
  });

  it('keeps redaction under a calendar-scope grant (scope boundary)', async () => {
    const [approval] = await loadApprovals([grantRow({ scope: 'calendar_detail' })]);
    expect(approval?.teenRedacted).toBe(true);
    expect(JSON.stringify(approval)).not.toContain(TEEN_QUOTE);
  });

  it('keeps redaction under an EXPIRED grant', async () => {
    const expired = grantRow({
      startsAt: new Date('2026-07-20T09:00:00.000Z'),
      expiresAt: new Date('2026-07-25T09:00:00.000Z'),
    });
    const [approval] = await loadApprovals([expired]);
    expect(approval?.teenRedacted).toBe(true);
    expect(JSON.stringify(approval)).not.toContain(TEEN_QUOTE);
  });

  it('keeps redaction under an UNASSENTED grant (rule #5)', async () => {
    const [approval] = await loadApprovals([
      grantRow({ teenAssentAt: null, startsAt: null, expiresAt: null }),
    ]);
    expect(approval?.teenRedacted).toBe(true);
    expect(JSON.stringify(approval)).not.toContain(TEEN_QUOTE);
  });

  it('reveals under an unassented SAFETY ESCALATION (the named exception)', async () => {
    const [approval] = await loadApprovals([
      grantRow({
        teenAssentAt: null,
        safetyEscalation: true,
        startsAt: new Date('2026-08-02T09:00:00.000Z'),
        expiresAt: new Date('2026-08-03T09:00:00.000Z'),
      }),
    ]);
    expect(approval?.teenRedacted).toBe(false);
    expect(approval?.payload).toEqual(APPROVAL_ROW.payload);
  });

  it('grants belonging to a DIFFERENT child never unlock this row', async () => {
    const [approval] = await loadApprovals([grantRow({ childId: 'someone-else' })]);
    expect(approval?.teenRedacted).toBe(true);
    expect(JSON.stringify(approval)).not.toContain(TEEN_QUOTE);
  });
});
