import { describe, expect, it, vi } from 'vitest';
import { loadSharedPicks } from './public-picks.js';

const FAMILY_ID = 'fam-uuid';
const TOKEN = 'tok_picks_123';
const RAW_TEEN_TITLE = 'Riverdale teen LGBTQ+ peer support drop-in';
const RAW_TEEN_SUMMARY = 'Confidential weekly group for your 15-year-old.';
const TEEN_CHILD_ID = 'child-teen-uuid';

interface Row {
  childId: string | null;
  title: string;
  kind: string;
  summary: string;
  sourceUrl: string | null;
  coverageNote: string | null;
  endorsementCount: number;
}

function endorsedFamilyWide(overrides: Partial<Row> = {}): Row {
  return {
    childId: null,
    title: 'Saturday family swim drop-in',
    kind: 'drop_in',
    summary: 'Parent-and-child swim at the community centre.',
    sourceUrl: 'https://example.org/swim',
    coverageNote: 'serves your area',
    endorsementCount: 4,
    ...overrides,
  };
}

/**
 * Fakes the two select chains loadSharedPicks runs:
 *   1. proposal+area  → select().from().innerJoin().where().limit()
 *   2. endorsed cands → select().from().innerJoin().where().orderBy().limit()
 * `chains[i]` is the rows the i-th select resolves.
 */
function fakeDb(chains: unknown[][]) {
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = chains[call] ?? [];
    call += 1;
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ limit, orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where, innerJoin: () => ({ where }) });
    const from = vi.fn().mockReturnValue({ innerJoin });
    return { from };
  });
  return { db: { select } as never };
}

describe('loadSharedPicks — public endorsed shortlist (rule #1)', () => {
  it('returns null for an unknown token — no candidate query', async () => {
    const { db } = fakeDb([[]]);
    expect(await loadSharedPicks('nope', db)).toBeNull();
  });

  it('surfaces only the safe allow-list with the aggregate count', async () => {
    const { db } = fakeDb([
      [{ familyId: FAMILY_ID, areaCoarse: 'M4L' }],
      [endorsedFamilyWide()],
    ]);

    const picks = await loadSharedPicks(TOKEN, db);

    expect(picks).not.toBeNull();
    expect(Object.keys(picks ?? {}).sort()).toEqual(['activities', 'areaCoarse']);
    expect(picks?.areaCoarse).toBe('M4L');
    expect(picks?.activities).toHaveLength(1);
    expect(Object.keys(picks?.activities[0] ?? {}).sort()).toEqual([
      'coverageNote',
      'endorsementCount',
      'kind',
      'sourceUrl',
      'summary',
      'title',
    ]);
    expect(picks?.activities[0]?.endorsementCount).toBe(4);
  });

  it('drops any child-attributed row defensively even if SQL returned one — no teen leak', async () => {
    const { db } = fakeDb([
      [{ familyId: FAMILY_ID, areaCoarse: 'M4L' }],
      [
        endorsedFamilyWide(),
        endorsedFamilyWide({
          childId: TEEN_CHILD_ID,
          title: RAW_TEEN_TITLE,
          summary: RAW_TEEN_SUMMARY,
        }),
      ],
    ]);

    const picks = await loadSharedPicks(TOKEN, db);

    expect(picks?.activities).toHaveLength(1);
    const serialized = JSON.stringify(picks);
    expect(serialized).not.toContain(RAW_TEEN_TITLE);
    expect(serialized).not.toContain(RAW_TEEN_SUMMARY);
    expect(serialized).not.toContain(TEEN_CHILD_ID);
  });

  it('drops an unsafe sourceUrl scheme to null', async () => {
    const { db } = fakeDb([
      [{ familyId: FAMILY_ID, areaCoarse: 'M4L' }],
      [endorsedFamilyWide({ sourceUrl: 'javascript:alert(1)' })],
    ]);

    const picks = await loadSharedPicks(TOKEN, db);
    expect(picks?.activities[0]?.sourceUrl).toBeNull();
  });
});
