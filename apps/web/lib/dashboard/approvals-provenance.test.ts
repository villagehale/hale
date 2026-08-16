import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-260 · WS3b — the toddler family with a teen sibling could not approve anything
 * Hale drafted for the WHOLE family.
 *
 * The rule-#1 double-miss fallback redacts a draft the classifier could not attribute
 * to a child whenever the family has a teenager. That is right for content that came
 * from OUTSIDE — an ingested email, a classified message — where "unattributed" really
 * does mean "might be the teen's". It is wrong for a draft Hale AUTHORED from public
 * reference data: a municipal registration window has no child-authored content in it
 * to protect, and there is no child to attribute it to because it is about the
 * household. Redacted anyway, the card showed the placeholder instead of the
 * shortlist, and `redactsTeenContent` returns true unconditionally for a null childId,
 * so NO grant could ever unlock it — a permanent dead end on the one action the
 * registration ladder is built around.
 *
 * The fix is PROVENANCE, recorded at mint time, and it fails closed: anything
 * unlabelled reads as 'child_content' and keeps today's behaviour exactly.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_DOB = '2011-01-01'; // ~15y at NOW → teenager
const NOW = new Date('2026-08-02T12:00:00.000Z');

const SHORTLIST_PAYLOAD = {
  intentKind: 'registration_shortlist',
  title: 'Burlington recreation programs and swim lessons',
  summary: 'Registration opens Saturday. I never register for you.',
  source_url: 'https://www.burlington.ca/registering',
};

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: async () => FAMILY_ID,
  currentUserId: async () => PARENT_ID,
}));

/** A family-scoped draft: no child attributed, teen_content false (there is no teen
 * content in it), in a family that HAS a teenager — the double-miss shape. */
function approvalRow(contentProvenance: string) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    actionType: 'add_to_digest_only',
    payload: SHORTLIST_PAYLOAD,
    reviewerVerdict: 'approved',
    reviewerVerdictAt: new Date('2026-08-02T08:05:00.000Z'),
    reviewerToolResults: [],
    draftedAt: new Date('2026-08-01T10:00:00Z'),
    teenContent: false,
    childId: null,
    childName: null,
    childDob: null,
    contentProvenance,
  };
}

function fakeDb(row: Record<string, unknown>) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => [{ dateOfBirth: TEEN_DOB }] }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
      };
    }
    if (keys.includes('safetyEscalation') && keys.includes('scope')) {
      return { from: () => ({ where: async () => [] }) };
    }
    // buildActorResolver: select({ userId, role }) from family_members — an empty
    // household means every audit actor resolves to Hale, which is the safe default
    // these fixtures want (none of them exercise a human approval).
    if (keys.length === 2 && keys.includes('userId') && keys.includes('role')) {
      return { from: () => ({ where: async () => [] }) };
    }
    // loadActionAuditFacts: the reviewer-note + human-approval audit read.
    if (keys.includes('actionTaken') && keys.includes('occurredAt')) {
      return { from: () => ({ where: () => ({ orderBy: async () => [] }) }) };
    }
    const node = () =>
      Object.assign(Promise.resolve([row]), {
        limit: () => Promise.resolve([row]),
        orderBy: () => node(),
      });
    return {
      from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => node() }) }) }),
    };
  });
  return { select } as unknown as Record<string, unknown>;
}

async function loadApprovals(row: Record<string, unknown>) {
  vi.doMock('~/lib/db', () => ({ db: () => fakeDb(row) }));
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

describe('loadPendingApprovals × content provenance (rule #1 double-miss)', () => {
  it('lets the parent approve a Hale-authored family draft in a family with a teen', async () => {
    const [approval] = await loadApprovals(approvalRow('hale_authored'));

    expect(approval?.teenRedacted).toBe(false);
    // The whole point: the shortlist the approval is FOR is visible, so the parent is
    // deciding on something they can read.
    expect(approval?.payload).toEqual(SHORTLIST_PAYLOAD);
    expect(approval?.preview).toContain('Burlington recreation programs and swim lessons');
  });

  it('keeps an unattributed CLASSIFIED draft gated in the same family (unchanged)', async () => {
    const [approval] = await loadApprovals(approvalRow('child_content'));

    expect(approval?.teenRedacted).toBe(true);
    expect(approval?.payload).toBeNull();
    expect(JSON.stringify(approval)).not.toContain('Burlington');
  });

  it('fails closed: an unlabelled draft keeps today’s redaction', async () => {
    // A row written before the column existed, or by a mint site that never declared
    // its provenance. The default is the private answer, never the open one.
    const { contentProvenance: _unlabelled, ...row } = approvalRow('child_content');
    const [approval] = await loadApprovals({ ...row, contentProvenance: undefined });

    expect(approval?.teenRedacted).toBe(true);
    expect(approval?.payload).toBeNull();
  });
});
