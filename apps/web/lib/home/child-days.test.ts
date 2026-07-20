import { describe, expect, it, vi } from 'vitest';

/**
 * Per-active-child Home Row 2 aggregates (foldChildDays) + the duration formatter.
 * The load-bearing rule-#1 assertion: a 13+ child's OWN (non-parent-authored)
 * episode is dropped before it can reach that child's highlights/sleep/meals — the
 * same dropTeenEpisodes redaction the recent-logs list and the stat row apply. The
 * chart/counters are all real logged aggregates (nap minutes, feed counts,
 * milestone counts), never the prototype's sample bar heights.
 */

vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn(), currentUserId: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: vi.fn() }));
vi.mock('~/lib/dashboard/queries', () => ({ loadFamilyTimezone: vi.fn() }));

const { foldChildDays, formatDurationMinutes } = await import('./child-days.js');
type Days = Awaited<ReturnType<typeof foldChildDays>>[number];

/** The single expected child-days entry (noUncheckedIndexedAccess narrows [0]). */
function only(list: Days[]): Days {
  const [first] = list;
  if (!first) throw new Error('expected one child-days entry');
  return first;
}

const NOW = new Date('2026-06-21T16:00:00Z'); // 12:00 noon June 21 in America/Toronto (EDT)
const TZ = 'America/Toronto';
const PARENT_ID = 'parent-1';
const BABY_ID = 'baby-1';
const TEEN_ID = 'teen-1';
const BABY_DOB = '2024-05-12'; // toddler
const TEEN_DOB = '2011-01-01'; // ~15yo

interface Row {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

function row(over: Partial<Row> & { id: string; occurredAt: Date }): Row {
  return {
    childId: BABY_ID,
    authoredBy: PARENT_ID,
    episodeType: 'feed',
    summary: '',
    payload: {},
    ...over,
  };
}

describe('formatDurationMinutes', () => {
  it('renders whole hours, hours+minutes, and bare minutes', () => {
    expect(formatDurationMinutes(135)).toBe('2h 15m');
    expect(formatDurationMinutes(90)).toBe('1h 30m');
    expect(formatDurationMinutes(60)).toBe('1h');
    expect(formatDurationMinutes(45)).toBe('45m');
    expect(formatDurationMinutes(0)).toBe('0m');
  });
});

describe('foldChildDays — per-child Home Row 2', () => {
  const CHILDREN = [{ id: BABY_ID, dateOfBirth: BABY_DOB }];

  const BABY_ROWS: Row[] = [
    row({ id: 'f1', episodeType: 'feed', summary: 'Fed 120 ml (bottle)', occurredAt: new Date('2026-06-21T13:00:00Z') }), // 09:00
    row({ id: 'f2', episodeType: 'feed', summary: 'Fed — most of it', occurredAt: new Date('2026-06-21T16:30:00Z') }), // 12:30
    row({ id: 'n1', episodeType: 'nap', summary: 'Napped 90 min — good', payload: { durationMin: 90 }, occurredAt: new Date('2026-06-21T14:00:00Z') }),
    row({ id: 'n2', episodeType: 'nap', summary: 'Napped 45 min', payload: { durationMin: 45 }, occurredAt: new Date('2026-06-21T18:00:00Z') }),
    row({ id: 'n3', episodeType: 'nap', summary: 'Napped 60 min', payload: { durationMin: 60 }, occurredAt: new Date('2026-06-20T18:00:00Z') }), // yesterday
    row({ id: 'm1', episodeType: 'milestone', summary: 'First steps', occurredAt: new Date('2026-06-21T15:00:00Z') }),
    row({ id: 'm2', episodeType: 'milestone', summary: 'Waved bye', occurredAt: new Date('2026-06-18T15:00:00Z') }), // 3 days ago
    row({ id: 'd1', episodeType: 'diaper', summary: 'Wet diaper', occurredAt: new Date('2026-06-21T17:00:00Z') }),
  ];

  it("today's highlights are today-only, newest-first, capped at 5, with a kind label + time", () => {
    const days = only(foldChildDays(BABY_ROWS, CHILDREN, PARENT_ID, TZ, NOW));
    // Six episodes fall on June 21 (Toronto); the cap keeps the five newest.
    expect(days.highlights.map((h) => h.id)).toEqual(['n2', 'd1', 'f2', 'm1', 'n1']);
    expect(days.highlights[0]).toMatchObject({ id: 'n2', kindLabel: 'Nap' });
    expect(days.highlights.find((h) => h.id === 'm1')?.kindLabel).toBe('Milestone');
    expect(days.highlights.find((h) => h.id === 'f2')?.kindLabel).toBe('Feed');
    // The 3-days-ago milestone is not "today", so it stays out of highlights.
    expect(days.highlights.some((h) => h.id === 'm2')).toBe(false);
  });

  it("meals are today's feeds only, with a full today-count", () => {
    const days = only(foldChildDays(BABY_ROWS, CHILDREN, PARENT_ID, TZ, NOW));
    expect(days.mealsToday).toBe(2);
    expect(days.meals.map((m) => m.id)).toEqual(['f2', 'f1']);
    // Times are formatted in the family's zone (24-hour): 16:30Z → 12:30, 13:00Z → 09:00.
    expect(days.meals.map((m) => m.time)).toEqual(['12:30', '09:00']);
  });

  it('sleepWeek buckets nap minutes per local day (oldest→newest, today last)', () => {
    const days = only(foldChildDays(BABY_ROWS, CHILDREN, PARENT_ID, TZ, NOW));
    expect(days.sleepWeek).toEqual([0, 0, 0, 0, 0, 60, 135]);
    expect(days.todaySleepMin).toBe(135);
  });

  it('avgSleepMin averages only days that have logged sleep', () => {
    const days = only(foldChildDays(BABY_ROWS, CHILDREN, PARENT_ID, TZ, NOW));
    // (135 today + 60 yesterday) / 2 days-with-sleep = 97.5 → 98
    expect(days.avgSleepMin).toBe(98);
  });

  it('milestonesThisWeek counts every milestone in the 7-day window', () => {
    const days = only(foldChildDays(BABY_ROWS, CHILDREN, PARENT_ID, TZ, NOW));
    expect(days.milestonesThisWeek).toBe(2);
  });

  it('a child with no episodes gets an all-empty, all-zero, null-avg entry', () => {
    const days = only(foldChildDays([], CHILDREN, PARENT_ID, TZ, NOW));
    expect(days).toMatchObject({
      childId: BABY_ID,
      highlights: [],
      meals: [],
      mealsToday: 0,
      sleepWeek: [0, 0, 0, 0, 0, 0, 0],
      todaySleepMin: 0,
      avgSleepMin: null,
      milestonesThisWeek: 0,
    });
  });

  it('drops a teen’s OWN episode (rule #1) but keeps the parent-authored one', () => {
    const children = [{ id: TEEN_ID, dateOfBirth: TEEN_DOB }];
    const rows: Row[] = [
      row({
        id: 't-own',
        childId: TEEN_ID,
        authoredBy: null, // teen's own content → dropped for the parent
        episodeType: 'milestone',
        summary: 'Made the team',
        occurredAt: new Date('2026-06-21T15:00:00Z'),
      }),
      row({
        id: 't-parent',
        childId: TEEN_ID,
        authoredBy: PARENT_ID, // parent's own log about their teen → kept
        episodeType: 'milestone',
        summary: 'Learner’s permit',
        occurredAt: new Date('2026-06-21T16:00:00Z'),
      }),
    ];
    const days = only(foldChildDays(rows, children, PARENT_ID, TZ, NOW));
    expect(days.highlights.map((h) => h.id)).toEqual(['t-parent']);
    expect(days.milestonesThisWeek).toBe(1);
  });

  it('returns one entry per child, in the input child order', () => {
    const children = [
      { id: BABY_ID, dateOfBirth: BABY_DOB },
      { id: TEEN_ID, dateOfBirth: TEEN_DOB },
    ];
    const days = foldChildDays(BABY_ROWS, children, PARENT_ID, TZ, NOW);
    expect(days.map((d) => d.childId)).toEqual([BABY_ID, TEEN_ID]);
  });
});
