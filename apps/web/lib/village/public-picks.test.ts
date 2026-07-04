import { afterEach, describe, expect, it, vi } from 'vitest';
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
  supersededAt: Date | null;
  discoveredAt: Date;
  eventDate: string | null;
  cadence: string | null;
  seasons: string[] | null;
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
    supersededAt: null,
    discoveredAt: new Date(),
    eventDate: null,
    cadence: null,
    seasons: null,
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

  it('excludes superseded and past endorsed picks from the shared shortlist (stale-pile fix)', async () => {
    const { db } = fakeDb([
      [{ familyId: FAMILY_ID, areaCoarse: 'M4L' }],
      [
        endorsedFamilyWide({ title: 'Fresh endorsed swim' }),
        endorsedFamilyWide({ title: 'Superseded pick', supersededAt: new Date() }),
        endorsedFamilyWide({ title: 'Past endorsed festival', eventDate: '2020-01-01' }),
      ],
    ]);

    const picks = await loadSharedPicks(TOKEN, db);

    expect(picks?.activities.map((a) => a.title)).toEqual(['Fresh endorsed swim']);
  });

  it('applies the SHARING family timezone to the dated-event day boundary (not UTC/Toronto)', async () => {
    // 01:30 Jul 4 in Toronto is still 22:30 Jul 3 in Vancouver: a Jul-3 event has
    // passed under Toronto's local day but is "today" under Vancouver's — it
    // survives ONLY because the sharing family's tz threads into visibleCandidates.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T05:30:00Z'));
    const { db } = fakeDb([
      [{ familyId: FAMILY_ID, areaCoarse: 'M4L' }],
      [endorsedFamilyWide({ title: 'Vancouver Jul 3 fair', eventDate: '2026-07-03' })],
      // the sharing family's timezone row (readFamilyTimezone's third select)
      [{ timezone: 'America/Vancouver' }],
    ]);

    const picks = await loadSharedPicks(TOKEN, db);

    expect(picks?.activities.map((a) => a.title)).toEqual(['Vancouver Jul 3 fair']);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
