import { describe, expect, it } from 'vitest';
import type { LogView } from './api-types';
import { dayHeading, groupLogsByDay } from './logs-group';

/**
 * The glance-detail list groups a flat, newest-first page into day sections in
 * order, each with a Today/Yesterday/date heading. Expected values are derived from
 * the spec (bucket by local day, newest day first, within-day order preserved), not
 * copied from output. now is injected so the headings are deterministic.
 */

const NOW = new Date('2026-07-07T12:00:00');

function log(id: string, occurredAt: string): LogView {
  return { id, childId: 'c1', episodeType: 'nap', summary: `s-${id}`, occurredAt, durationMin: 30 };
}

describe('groupLogsByDay', () => {
  it('buckets rows into day sections, newest first, preserving within-day order', () => {
    const rows = [
      log('a', '2026-07-07T18:00:00'),
      log('b', '2026-07-07T09:00:00'),
      log('c', '2026-07-06T20:00:00'),
    ];
    const groups = groupLogsByDay(rows, NOW);
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-07-07', '2026-07-06']);
    expect(groups[0]?.logs.map((l) => l.id)).toEqual(['a', 'b']);
    expect(groups[1]?.logs.map((l) => l.id)).toEqual(['c']);
  });

  it('returns [] for no rows (the caller shows the calm empty state)', () => {
    expect(groupLogsByDay([], NOW)).toEqual([]);
  });
});

describe('dayHeading', () => {
  it('reads Today for the current local day and Yesterday for the day before', () => {
    expect(dayHeading('2026-07-07', NOW)).toBe('Today');
    expect(dayHeading('2026-07-06', NOW)).toBe('Yesterday');
  });

  it('reads a weekday+date for an older day', () => {
    // 2026-07-01 is a Wednesday.
    expect(dayHeading('2026-07-01', NOW)).toContain('Jul 1');
  });
});
