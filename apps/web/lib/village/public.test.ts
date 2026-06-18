import { describe, expect, it, vi } from 'vitest';
import {
  type PublicCandidateRow,
  type PublicProposalRow,
  loadSharedWeekPlan,
  toPublicWeekPlan,
} from './public.js';

const RAW_TITLE = 'Riverdale teen LGBTQ+ peer support drop-in';
const RAW_SUMMARY = 'Confidential weekly group for your 15-year-old.';
const RAW_COVERAGE = 'serves the east-end neighbourhoods';
const RAW_SOURCE_URL = 'https://example.org/riverdale-teen-group';
const CHILD_ID = 'child-teen-uuid';
const FAMILY_ID = 'fam-uuid';

function familyWideCandidate(overrides: Partial<PublicCandidateRow> = {}): PublicCandidateRow {
  return {
    childId: null,
    title: 'Saturday family swim drop-in',
    kind: 'drop_in',
    summary: 'Parent-and-child swim at the community centre.',
    sourceUrl: 'https://example.org/swim',
    coverageNote: 'serves your area',
    ...overrides,
  };
}

function proposal(overrides: Partial<PublicProposalRow> = {}): PublicProposalRow {
  return {
    weekOf: '2026-06-15',
    items: [],
    ...overrides,
  };
}

describe('toPublicWeekPlan — privacy contract (rule #1)', () => {
  it('exposes ONLY the safe allow-list: weekOf, areaCoarse, activities with the safe candidate fields', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [familyWideCandidate()],
    });

    expect(plan).not.toBeNull();
    expect(Object.keys(plan ?? {}).sort()).toEqual(['activities', 'areaCoarse', 'weekOf']);
    expect(plan?.weekOf).toBe('2026-06-15');
    expect(plan?.areaCoarse).toBe('M4L');

    const activity = plan?.activities[0];
    expect(activity).toBeDefined();
    expect(Object.keys(activity ?? {}).sort()).toEqual([
      'coverageNote',
      'kind',
      'sourceUrl',
      'summary',
      'title',
    ]);
    expect(activity?.title).toBe('Saturday family swim drop-in');
    expect(activity?.kind).toBe('drop_in');
  });

  it('DROPS any candidate attributed to a child (childId set) — no child-linked row is public', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [
        familyWideCandidate(),
        {
          childId: CHILD_ID,
          title: RAW_TITLE,
          kind: 'support_group',
          summary: RAW_SUMMARY,
          sourceUrl: RAW_SOURCE_URL,
          coverageNote: RAW_COVERAGE,
        },
      ],
    });

    expect(plan?.activities).toHaveLength(1);
    expect(plan?.activities[0]?.kind).toBe('drop_in');

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_SUMMARY);
    expect(serialized).not.toContain(RAW_COVERAGE);
    expect(serialized).not.toContain(RAW_SOURCE_URL);
    expect(serialized).not.toContain(CHILD_ID);
  });

  it('never leaks childId, familyId, or any internal id even from the family-wide rows it keeps', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'Toronto',
      candidates: [familyWideCandidate()],
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('childId');
    expect(serialized).not.toContain('child_id');
    expect(serialized).not.toContain('familyId');
    expect(serialized).not.toContain('family_id');
    expect(serialized).not.toContain(FAMILY_ID);
    expect(serialized).not.toContain(CHILD_ID);
  });

  it('drops proposal items attributed to a child; keeps it as activity count only when family-wide', () => {
    // Proposal items also carry childId in jsonb. They never carry their own
    // surfaced copy in the public view (activities come from candidates), but the
    // mapper must not echo a child-attributed item's raw text anywhere.
    const plan = toPublicWeekPlan({
      proposal: proposal({
        items: [
          { title: RAW_TITLE, kind: 'support_group', childId: CHILD_ID, stageNote: RAW_SUMMARY },
          {
            title: 'Family park day',
            kind: 'activity',
            childId: null,
            stageNote: 'whole household',
          },
        ],
      }),
      areaCoarse: 'M4L',
      candidates: [familyWideCandidate()],
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_SUMMARY);
    expect(serialized).not.toContain(CHILD_ID);
  });

  it('returns null areaCoarse passthrough when the family opted out of an area (never fabricates one)', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: null,
      candidates: [familyWideCandidate()],
    });

    expect(plan?.areaCoarse).toBeNull();
  });
});

describe('toPublicWeekPlan — untrusted text/URL hardening (rule #1, FIX 2)', () => {
  it('drops a non-http(s) sourceUrl (javascript:) to null', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [familyWideCandidate({ sourceUrl: 'javascript:alert(1)' })],
    });

    expect(plan?.activities[0]?.sourceUrl).toBeNull();
  });

  it('drops a data: URL and a relative URL to null', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [
        familyWideCandidate({ sourceUrl: 'data:text/html,<script>1</script>' }),
        familyWideCandidate({ sourceUrl: '/relative/path' }),
      ],
    });

    expect(plan?.activities[0]?.sourceUrl).toBeNull();
    expect(plan?.activities[1]?.sourceUrl).toBeNull();
  });

  it('keeps a valid absolute http and https sourceUrl', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [
        familyWideCandidate({ sourceUrl: 'https://ex.com/a' }),
        familyWideCandidate({ sourceUrl: 'http://ex.com/b' }),
      ],
    });

    expect(plan?.activities[0]?.sourceUrl).toBe('https://ex.com/a');
    expect(plan?.activities[1]?.sourceUrl).toBe('http://ex.com/b');
  });

  it('truncates title, summary, and coverageNote to their caps', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [
        familyWideCandidate({
          title: 'T'.repeat(500),
          summary: 'S'.repeat(900),
          coverageNote: 'C'.repeat(500),
        }),
      ],
    });

    const activity = plan?.activities[0];
    expect(activity?.title).toHaveLength(200);
    expect(activity?.summary).toHaveLength(600);
    expect(activity?.coverageNote).toHaveLength(300);
  });

  it('leaves a null coverageNote null (does not fabricate text)', () => {
    const plan = toPublicWeekPlan({
      proposal: proposal(),
      areaCoarse: 'M4L',
      candidates: [familyWideCandidate({ coverageNote: null })],
    });

    expect(plan?.activities[0]?.coverageNote).toBeNull();
  });
});

const SHARE_TOKEN = 'tok_abc123';

/**
 * Fakes the three select chains loadSharedWeekPlan runs:
 *   1. proposal (joined to families.areaCoarse) by share_token
 *   2. village_candidates for the family
 * Each entry in `chains` is the resolved rows for the next select(...) call.
 */
function fakeDb(chains: unknown[][]) {
  let call = 0;
  const limitSpy = vi.fn();
  const orderBySpy = vi.fn();
  const select = vi.fn().mockImplementation(() => {
    const rows = chains[call] ?? [];
    call += 1;
    // The candidate query is .where().orderBy().limit(); the proposal query is
    // .innerJoin().where().limit(). Make limit() and orderBy() both record their
    // args and resolve the rows, and let orderBy() also be chainable into limit.
    const limit = vi.fn().mockImplementation((n: number) => {
      limitSpy(n);
      return Promise.resolve(rows);
    });
    const orderBy = vi.fn().mockImplementation((col: unknown) => {
      orderBySpy(col);
      return Object.assign(Promise.resolve(rows), { limit });
    });
    const where = vi.fn().mockReturnValue({ limit, orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ where, innerJoin });
    return { from };
  });
  return { db: { select } as never, limitSpy, orderBySpy };
}

describe('loadSharedWeekPlan', () => {
  it('returns null for an unknown token — no proposal row, no candidate query', async () => {
    const { db } = fakeDb([[]]);

    const result = await loadSharedWeekPlan('does-not-exist', db);

    expect(result).toBeNull();
  });

  it('returns the public week plan when the token resolves a proposal', async () => {
    const { db } = fakeDb([
      [{ proposalFamilyId: FAMILY_ID, weekOf: '2026-06-15', items: [], areaCoarse: 'M4L' }],
      [familyWideCandidate()],
    ]);

    const result = await loadSharedWeekPlan(SHARE_TOKEN, db);

    expect(result).not.toBeNull();
    expect(result?.weekOf).toBe('2026-06-15');
    expect(result?.areaCoarse).toBe('M4L');
    expect(result?.activities).toHaveLength(1);
    // The plan exposes only the allow-listed top-level keys.
    expect(Object.keys(result ?? {}).sort()).toEqual(['activities', 'areaCoarse', 'weekOf']);
  });

  it('bounds the public candidate query to the 24 most recent (FIX 4)', async () => {
    const { db, limitSpy, orderBySpy } = fakeDb([
      [{ proposalFamilyId: FAMILY_ID, weekOf: '2026-06-15', items: [], areaCoarse: 'M4L' }],
      [familyWideCandidate()],
    ]);

    await loadSharedWeekPlan(SHARE_TOKEN, db);

    expect(limitSpy).toHaveBeenCalledWith(24);
    expect(orderBySpy).toHaveBeenCalledTimes(1);
  });
});
