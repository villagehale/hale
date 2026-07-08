import { describe, expect, it, vi } from 'vitest';

/**
 * Home stat aggregates (readHomeStats) over a fake db. The load-bearing rule-#1
 * assertion: the "logs this week" count is post-redaction — a 13+ child's own
 * (pipeline-authored) episode is dropped BEFORE the count, so the number never
 * betrays that something was logged about the teen. The health count is a
 * family total derived from the curated schedule (teens contribute none), and the
 * saved-places count is the authoritative all-saves size.
 */

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn(), currentUserId: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: vi.fn() }));

const { readHomeStats } = await import('./aggregates.js');

const NOW = new Date('2026-06-21T12:00:00Z');
const FAMILY_ID = 'fam-1';
const PARENT_ID = 'parent-1';
const TEEN_ID = 'teen-1';
const BABY_ID = 'baby-1';

// A ~2-month-old (a 2-month well-baby + immunization are imminent) and a ~15yo teen
// (past the 144mo curated schedule → contributes no upcoming health).
const TEEN_DOB = '2011-01-01';
const BABY_DOB = '2026-04-15';

interface WeekEpisodeRow {
  childId: string | null;
  authoredBy: string | null;
}

/**
 * A fake db that routes each select() by its projection keys to the right dataset,
 * mirroring the shape trail-double-miss.test uses. The three reads readHomeStats
 * issues directly are: children (id+dateOfBirth), the week's episodes
 * (childId+authoredBy), and the saved candidate ids (candidateId). companionForFamily
 * (called through) issues its own children read (id+name+dateOfBirth) and a
 * done-episodes read (childId+episodeType+payload).
 */
function fakeDb(opts: {
  children: Array<{ id: string; dateOfBirth: string; name?: string }>;
  weekEpisodes: WeekEpisodeRow[];
  savedCandidateIds: string[];
  doneEpisodes?: Array<{ childId: string | null; episodeType: string; payload: Record<string, unknown> }>;
}) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});

    // children read for readHomeStats: { id, dateOfBirth }
    if (keys.length === 2 && keys.includes('id') && keys.includes('dateOfBirth')) {
      return { from: () => ({ where: async () => opts.children }) };
    }
    // children read for companionForFamily: { id, name, dateOfBirth }
    if (keys.length === 3 && keys.includes('id') && keys.includes('name')) {
      return {
        from: () => ({
          where: () => ({
            orderBy: async () => opts.children.map((c) => ({ ...c, name: c.name ?? 'Child' })),
          }),
        }),
      };
    }
    // the week's episodes: { childId, authoredBy }
    if (keys.length === 2 && keys.includes('childId') && keys.includes('authoredBy')) {
      return {
        from: () => ({ where: () => ({ orderBy: async () => opts.weekEpisodes }) }),
      };
    }
    // companionForFamily's done-episodes read: { childId, episodeType, payload }
    if (keys.includes('episodeType') && keys.includes('payload')) {
      return { from: () => ({ where: async () => opts.doneEpisodes ?? [] }) };
    }
    // listFamilySavedCandidateIds: { candidateId }
    if (keys.length === 1 && keys[0] === 'candidateId') {
      return {
        from: () => ({
          where: async () => opts.savedCandidateIds.map((id) => ({ candidateId: id })),
        }),
      };
    }
    throw new Error(`unexpected select projection: ${keys.join(',')}`);
  });
  return { select } as never;
}

describe('readHomeStats — Home stat aggregates', () => {
  it('counts this-week logs AFTER teen redaction — a teen episode never inflates the count', async () => {
    const database = fakeDb({
      children: [
        { id: TEEN_ID, dateOfBirth: TEEN_DOB },
        { id: BABY_ID, dateOfBirth: BABY_DOB },
      ],
      // 3 rows this week: baby (kept), family note by this parent (kept), teen's own
      // pipeline-authored episode (DROPPED by rule #1). Redacted count = 2.
      weekEpisodes: [
        { childId: BABY_ID, authoredBy: PARENT_ID },
        { childId: null, authoredBy: PARENT_ID },
        { childId: TEEN_ID, authoredBy: null },
      ],
      savedCandidateIds: ['c1', 'c2'],
    });

    const stats = await readHomeStats(database, FAMILY_ID, PARENT_ID, NOW);

    expect(stats.logsThisWeek).toBe(2);
    expect(stats.savedPlaces).toBe(2);
    // A ~2-month-old has imminent curated items; a 15yo contributes none (family total).
    expect(stats.upcomingHealth).toBeGreaterThan(0);
  });

  it('a raw COUNT would be 3 — the redacted count proves the teen row was excluded', async () => {
    const database = fakeDb({
      children: [{ id: TEEN_ID, dateOfBirth: TEEN_DOB }],
      // A single teen-attributed, pipeline-authored episode this week.
      weekEpisodes: [{ childId: TEEN_ID, authoredBy: null }],
      savedCandidateIds: [],
    });

    const stats = await readHomeStats(database, FAMILY_ID, PARENT_ID, NOW);

    // Rule #1: the teen's own episode is dropped, so the count reads 0 — NOT 1.
    expect(stats.logsThisWeek).toBe(0);
  });

  it('an in-window health item already marked done is NOT counted as coming up', async () => {
    // A ~2-month-old has two in-window curated items (2mo well-child + 2mo shots).
    // Marking the well-child visit done writes a health_done episode carrying its
    // stable key; that item must drop out of the "coming up" count — so 2 → 1.
    const database = fakeDb({
      children: [{ id: BABY_ID, dateOfBirth: BABY_DOB }],
      weekEpisodes: [],
      savedCandidateIds: [],
      doneEpisodes: [
        { childId: BABY_ID, episodeType: 'health_done', payload: { healthKey: '2-well_child_visit' } },
      ],
    });

    const withDone = await readHomeStats(database, FAMILY_ID, null, NOW);

    const noDone = await readHomeStats(
      fakeDb({ children: [{ id: BABY_ID, dateOfBirth: BABY_DOB }], weekEpisodes: [], savedCandidateIds: [] }),
      FAMILY_ID,
      null,
      NOW,
    );

    expect(noDone.upcomingHealth).toBe(2);
    expect(withDone.upcomingHealth).toBe(1);
  });

  it('a teenager contributes zero upcoming health items (curated schedule ends pre-teen)', async () => {
    const database = fakeDb({
      children: [{ id: TEEN_ID, dateOfBirth: TEEN_DOB }],
      weekEpisodes: [],
      savedCandidateIds: [],
    });

    const stats = await readHomeStats(database, FAMILY_ID, null, NOW);

    expect(stats.upcomingHealth).toBe(0);
    expect(stats.logsThisWeek).toBe(0);
    expect(stats.savedPlaces).toBe(0);
  });
});
