import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HomeChildDays } from '~/lib/home/child-days';
import { HomeChildRow2 } from './home-child-row2';

/**
 * Home Row 2 (design handoff §4.2) renders REAL logged aggregates for the active
 * child, and — the honesty lane — a calm empty state per card when nothing is
 * logged, never a fabricated bar/time. Rendered to static HTML (repo idiom).
 *
 * The component pulls formatDurationMinutes from the child-days module, whose
 * request wrapper imports the server/auth graph (next-auth → next/server); stub
 * those so this markup-only test doesn't drag it in (same idiom as
 * ask-hale-thread.test).
 */
vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn(), currentUserId: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: vi.fn() }));
vi.mock('~/lib/dashboard/queries', () => ({ loadFamilyTimezone: vi.fn() }));

const WITH_DATA: HomeChildDays = {
  childId: 'c1',
  highlights: [
    { id: 'h1', summary: 'Napped 45 min — good', kindLabel: 'Nap', time: '14:00' },
    { id: 'h2', summary: 'First steps', kindLabel: 'Milestone', time: '11:00' },
  ],
  meals: [{ id: 'm1', summary: 'Fed 120 ml (bottle)', kindLabel: 'Feed', time: '09:00' }],
  mealsToday: 2,
  todaySleepMin: 135,
  sleepWeek: [0, 0, 0, 0, 0, 60, 135],
  avgSleepMin: 98,
  milestonesThisWeek: 1,
};

const EMPTY: HomeChildDays = {
  childId: 'c1',
  highlights: [],
  meals: [],
  mealsToday: 0,
  todaySleepMin: 0,
  sleepWeek: [0, 0, 0, 0, 0, 0, 0],
  avgSleepMin: null,
  milestonesThisWeek: 0,
};

function render(day: HomeChildDays): string {
  return renderToStaticMarkup(createElement(HomeChildRow2, { day, childName: 'Robin' }));
}

describe('HomeChildRow2 — real data', () => {
  it('renders the logged highlights with their kind label and time', () => {
    const html = render(WITH_DATA);
    expect(html).toContain('Napped 45 min — good');
    expect(html).toContain('First steps');
    expect(html).toContain('Nap');
    expect(html).toContain('14:00');
  });

  it('leads the sleep card with today’s real total and draws the 7-day chart', () => {
    const html = render(WITH_DATA);
    // 135 min → "2h 15m", labelled "logged today".
    expect(html).toContain('2h 15m');
    expect(html).toContain('logged today');
    // The chart is drawn (a fill bar exists for a day with logged sleep).
    expect(html).toContain('sleep-chart');
    expect(html).toContain('sleep-bar-fill');
  });

  it('shows the real meals count and today’s feeds', () => {
    const html = render(WITH_DATA);
    expect(html).toContain('meals logged today');
    expect(html).toContain('Fed 120 ml (bottle)');
    expect(html).toContain('09:00');
  });
});

describe('HomeChildRow2 — honest empty states', () => {
  it('shows a calm empty per card, and NO chart bars, when nothing is logged', () => {
    const html = render(EMPTY);
    expect(html).toContain('nothing logged for');
    expect(html).toContain('log sleep to see your week');
    expect(html).toContain('no meals logged today');
    // No fabricated chart: the sleep card is the empty state, not a zero-height chart.
    expect(html).not.toContain('sleep-bar-fill');
  });
});
