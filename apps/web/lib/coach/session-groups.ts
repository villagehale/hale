import type { ConversationSummary } from './history';

/**
 * The Ask session rail splits the family's conversations into "Today" and
 * "Earlier" and gives each a timestamp sub-line — both derived from the real
 * `lastMessageAt` (no category tag: the history query carries none). Grouping and
 * the labels depend on the CURRENT local day, so they are computed on the client
 * (the server's timezone would mis-bucket an evening chat); `nowMs` is injected so
 * the logic stays pure + testable.
 */

export interface SessionGroups {
  today: ConversationSummary[];
  earlier: ConversationSummary[];
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Buckets conversations into today (same local calendar day as `now`) vs earlier,
 * preserving the caller's order (listConversations already returns newest-first).
 */
export function groupConversations(
  conversations: ConversationSummary[],
  nowMs: number,
): SessionGroups {
  const todayStart = startOfLocalDay(nowMs);
  const today: ConversationSummary[] = [];
  const earlier: ConversationSummary[] = [];
  for (const c of conversations) {
    const at = Date.parse(c.lastMessageAt);
    if (at >= todayStart) today.push(c);
    else earlier.push(c);
  }
  return { today, earlier };
}

/**
 * The sub-line for one session row — a bare timestamp, never a fabricated
 * category. Same local day → clock time ("5:12 PM"); yesterday → "Yesterday";
 * within the last week → weekday ("Tuesday"); older → a date ("Jul 15", with the
 * year only when it differs from now's).
 */
export function sessionTimeLabel(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  const todayStart = startOfLocalDay(nowMs);
  if (at >= todayStart) {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (at >= todayStart - DAY_MS) return 'Yesterday';
  if (at >= todayStart - 6 * DAY_MS) {
    return new Date(at).toLocaleDateString(undefined, { weekday: 'long' });
  }
  const sameYear = new Date(at).getFullYear() === new Date(nowMs).getFullYear();
  return new Date(at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
