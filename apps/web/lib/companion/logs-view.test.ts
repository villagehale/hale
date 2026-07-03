import { describe, expect, it } from 'vitest';
import { groupLogsByDay, type LogView, nextCursorFrom, PAGE_LIMIT } from './logs-view.js';

/**
 * The dedicated logs view groups a flat, newest-first page into day sections in
 * order, then keyset-paginates by occurredAt. These are the DOM-free, server-free
 * contracts the Server Component + client browser rely on. Expected values are
 * derived from the spec (grouped by day, newest day first; cursor = the last row's
 * occurredAt only when a full page came back), not copied from output.
 */

function log(id: string, occurredAt: string, childId: string | null = null): LogView {
  return { id, childId, episodeType: 'feed', summary: `s-${id}`, occurredAt };
}

describe('groupLogsByDay', () => {
  it('buckets rows into day sections, newest day first, preserving within-day order', () => {
    const rows = [
      log('a', '2026-06-30T18:00:00Z'),
      log('b', '2026-06-30T09:00:00Z'),
      log('c', '2026-06-29T20:00:00Z'),
    ];

    const groups = groupLogsByDay(rows);

    expect(groups.map((g) => g.dayKey)).toEqual(['2026-06-30', '2026-06-29']);
    expect(groups[0]?.logs.map((l) => l.id)).toEqual(['a', 'b']);
    expect(groups[1]?.logs.map((l) => l.id)).toEqual(['c']);
  });

  it('returns [] for no rows (calm empty state, never a fabricated day)', () => {
    expect(groupLogsByDay([])).toEqual([]);
  });
});

describe('nextCursorFrom', () => {
  it('returns the last row occurredAt as the cursor when a full page came back (more may follow)', () => {
    const rows = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      log(`r${i}`, `2026-06-${String(10 + i).padStart(2, '0')}T12:00:00Z`),
    );

    expect(nextCursorFrom(rows, PAGE_LIMIT)).toBe(rows[rows.length - 1]?.occurredAt);
  });

  it('returns null on a short page (the last page — nothing more to load)', () => {
    const rows = [log('a', '2026-06-30T18:00:00Z')];

    expect(nextCursorFrom(rows, PAGE_LIMIT)).toBeNull();
  });

  it('returns null for an empty page', () => {
    expect(nextCursorFrom([], PAGE_LIMIT)).toBeNull();
  });
});
