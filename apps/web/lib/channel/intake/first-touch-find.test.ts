import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder, ActivityPick } from '~/lib/channel/activity/lane';
import {
  WEEK_FIND_BUDGET_MS,
  WEEK_FIND_SUBJECT,
  findThisWeek,
  findThisWeekWithin,
  renderWeekFind,
} from './first-touch-find';
import type { FirstTouchPlace } from './first-touch-place';

const TORONTO: FirstTouchPlace = {
  kind: 'postal',
  areaCoarse: 'M5V',
  postalCode: 'M5V 2T6',
  municipality: 'toronto',
  city: null,
};

const STORY: ActivityPick = {
  name: 'Storytime',
  ageFit: 'all ages',
  when: 'Saturday',
  price: null,
  sourceName: 'Library',
  source: 'web',
};

describe('findThisWeek', () => {
  it('names a missing finder and returns no lines', async () => {
    const found = await findThisWeek({ finder: null, place: TORONTO });
    expect(found).toEqual({ lines: [], outcome: 'not_configured' });
  });

  it('searches this week with no phone, no postal, and no household', async () => {
    let seen: unknown = null;
    const finder: ActivityFinder = {
      async find(query) {
        seen = query;
        return { found: false, reason: 'no_picks' };
      },
    };
    const found = await findThisWeek({ finder, place: TORONTO });
    expect(found.outcome).toBe('empty');
    expect(seen).toMatchObject({
      subject: WEEK_FIND_SUBJECT,
      window: 'this week',
      town: 'Toronto',
      stage: null,
    });
    expect(JSON.stringify(seen)).not.toContain('M5V');
    expect(JSON.stringify(seen)).not.toContain('416');
  });

  it('renders numbered pick lines and nothing else', () => {
    expect(renderWeekFind([])).toBeNull();
    expect(renderWeekFind(['Storytime (all ages) - Saturday'])).toBe(
      '1. Storytime (all ages) - Saturday',
    );
    expect(renderWeekFind(['Storytime (all ages) - Saturday'])).not.toContain(WEEK_FIND_SUBJECT);
  });

  it('names a search that outlasts the budget and does not wait it out', async () => {
    vi.useFakeTimers();
    const finder: ActivityFinder = {
      async find() {
        await new Promise((resolve) => setTimeout(resolve, WEEK_FIND_BUDGET_MS * 5));
        return { found: true, picks: [STORY] };
      },
    };
    const pending = findThisWeekWithin({ finder, place: TORONTO });
    await vi.advanceTimersByTimeAsync(WEEK_FIND_BUDGET_MS);
    await expect(pending).resolves.toEqual({ lines: [], outcome: 'budget' });
    vi.useRealTimers();
  });

  it('drops a pick that has no name', async () => {
    const finder: ActivityFinder = {
      async find() {
        return { found: true, picks: [{ ...STORY, name: '  ' }] };
      },
    };
    const found = await findThisWeek({ finder, place: TORONTO });
    expect(found).toEqual({ lines: [], outcome: 'empty' });
  });
});
