import { dayKeyOf } from '~/lib/format/datetime';
import { FEED_EPISODE, NAP_EPISODE } from './log-types.js';
import type { RecentLogView } from './recent-logs.js';

/**
 * A quiet at-a-glance line derived from the logs already loaded for the recent-logs
 * list ("last feed 2h 40m ago · 3 naps today") — no extra query, no new redaction
 * path. It reflects exactly the window the list shows (the most recent logs), so it
 * is honest about what's on screen rather than claiming a full-day total it can't
 * see. Returns null when there's nothing feed/nap to summarise.
 */
export function summarizeRecentLogs(
  logs: readonly RecentLogView[],
  timeZone: string,
  now: Date = new Date(),
): string | null {
  const parts: string[] = [];

  const lastFeed = logs.find((l) => l.episodeType === FEED_EPISODE);
  if (lastFeed) {
    parts.push(`last feed ${agoPhrase(new Date(lastFeed.occurredAt), now)}`);
  }

  const today = dayKeyOf(now, timeZone);
  const napsToday = logs.filter(
    (l) => l.episodeType === NAP_EPISODE && dayKeyOf(l.occurredAt, timeZone) === today,
  ).length;
  if (napsToday > 0) {
    parts.push(`${napsToday} ${napsToday === 1 ? 'nap' : 'naps'} today`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Coarse relative age of a past instant: "just now", "40m ago", "2h 40m ago",
 * "3d ago". Minute-grained under an hour, hour+minute under a day, day-grained
 * beyond. A future instant (clock skew) reads "just now".
 */
function agoPhrase(then: Date, now: Date): string {
  const totalMinutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (totalMinutes <= 0) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m ago`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${totalHours}h ago` : `${totalHours}h ${minutes}m ago`;
  }

  const days = Math.floor(totalHours / 24);
  return `${days}d ago`;
}
