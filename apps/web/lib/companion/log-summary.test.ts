import { describe, expect, it } from 'vitest';
import { summarizeRecentLogs } from './log-summary.js';
import { FEED_EPISODE, MILESTONE_EPISODE, NAP_EPISODE } from './log-types.js';
import type { RecentLogView } from './recent-logs.js';

const TZ = 'America/Toronto';
// 2026-06-21 14:00 ET (18:00 UTC in EDT). A fixed clock so relative ages are exact.
const NOW = new Date('2026-06-21T18:00:00Z');

function log(over: Partial<RecentLogView>): RecentLogView {
  return {
    id: 'e',
    childId: 'c',
    episodeType: NAP_EPISODE,
    summary: 's',
    occurredAt: NOW.toISOString(),
    ...over,
  };
}

describe('summarizeRecentLogs', () => {
  it('derives "last feed 2h 40m ago" from the most recent feed', () => {
    // 2h 40m before 18:00Z = 15:20Z.
    const logs = [
      log({ id: 'f', episodeType: FEED_EPISODE, occurredAt: '2026-06-21T15:20:00Z' }),
    ];
    expect(summarizeRecentLogs(logs, TZ, NOW)).toBe('last feed 2h 40m ago');
  });

  it('counts only naps that fall on today in the family zone', () => {
    const logs = [
      log({ id: 'n1', episodeType: NAP_EPISODE, occurredAt: '2026-06-21T13:00:00Z' }), // 9am ET today
      log({ id: 'n2', episodeType: NAP_EPISODE, occurredAt: '2026-06-21T17:00:00Z' }), // 1pm ET today
      // 2026-06-21T02:00Z = 2026-06-20 22:00 ET → yesterday in-zone, not counted.
      log({ id: 'n3', episodeType: NAP_EPISODE, occurredAt: '2026-06-21T02:00:00Z' }),
    ];
    expect(summarizeRecentLogs(logs, TZ, NOW)).toBe('2 naps today');
  });

  it('joins a feed and nap-count into one line, feed first', () => {
    const logs = [
      log({ id: 'f', episodeType: FEED_EPISODE, occurredAt: '2026-06-21T17:00:00Z' }), // 1h ago
      log({ id: 'n', episodeType: NAP_EPISODE, occurredAt: '2026-06-21T16:00:00Z' }), // today
    ];
    expect(summarizeRecentLogs(logs, TZ, NOW)).toBe('last feed 1h ago · 1 nap today');
  });

  it('returns null when there are no feed or nap logs to summarise', () => {
    const logs = [log({ id: 'm', episodeType: MILESTONE_EPISODE, summary: 'rolled over' })];
    expect(summarizeRecentLogs(logs, TZ, NOW)).toBeNull();
  });

  it('reads a sub-hour feed in minutes and an over-day feed in days', () => {
    expect(
      summarizeRecentLogs(
        [log({ id: 'f', episodeType: FEED_EPISODE, occurredAt: '2026-06-21T17:20:00Z' })],
        TZ,
        NOW,
      ),
    ).toBe('last feed 40m ago');
    expect(
      summarizeRecentLogs(
        [log({ id: 'f', episodeType: FEED_EPISODE, occurredAt: '2026-06-19T18:00:00Z' })],
        TZ,
        NOW,
      ),
    ).toBe('last feed 2d ago');
  });
});
