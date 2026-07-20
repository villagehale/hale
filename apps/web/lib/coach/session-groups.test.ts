import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from './history';
import { groupConversations, sessionTimeLabel } from './session-groups';

/**
 * The Ask session rail's pure split + timestamp labelling. Every expected value is
 * derived from the spec rules (same-day → time, yesterday → "Yesterday", …), not
 * copied from output. A fixed local `now` keeps the assertions deterministic.
 */

function summary(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: 'a chat',
    noteKey: null,
    lastMessageAt: '2026-07-19T12:00:00',
    messageCount: 2,
    ...over,
  };
}

// A local wall-clock reference: 2026-07-19 (Sunday), 18:30 local.
const NOW = new Date(2026, 6, 19, 18, 30, 0).getTime();

describe('groupConversations', () => {
  it('buckets same-local-day chats into today and older ones into earlier', () => {
    const list = [
      summary({ id: 'now', lastMessageAt: localIso(2026, 6, 19, 17, 12) }),
      summary({ id: 'dawn', lastMessageAt: localIso(2026, 6, 19, 0, 5) }),
      summary({ id: 'yest', lastMessageAt: localIso(2026, 6, 18, 23, 30) }),
      summary({ id: 'week', lastMessageAt: localIso(2026, 6, 10, 9, 0) }),
    ];
    const { today, earlier } = groupConversations(list, NOW);
    expect(today.map((c) => c.id)).toEqual(['now', 'dawn']);
    expect(earlier.map((c) => c.id)).toEqual(['yest', 'week']);
  });

  it('preserves the incoming (newest-first) order within each group', () => {
    const list = [
      summary({ id: 'b', lastMessageAt: localIso(2026, 6, 19, 9, 0) }),
      summary({ id: 'a', lastMessageAt: localIso(2026, 6, 19, 8, 0) }),
    ];
    expect(groupConversations(list, NOW).today.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('sessionTimeLabel', () => {
  it('shows a clock time for a same-day chat', () => {
    expect(sessionTimeLabel(localIso(2026, 6, 19, 17, 12), NOW)).toBe(
      new Date(2026, 6, 19, 17, 12).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });

  it('shows "Yesterday" for the prior calendar day', () => {
    expect(sessionTimeLabel(localIso(2026, 6, 18, 20, 0), NOW)).toBe('Yesterday');
  });

  it('shows the weekday within the last week', () => {
    // 2026-07-15 is a Wednesday.
    expect(sessionTimeLabel(localIso(2026, 6, 15, 10, 0), NOW)).toBe('Wednesday');
  });

  it('shows a month/day date for an older chat in the same year', () => {
    expect(sessionTimeLabel(localIso(2026, 5, 3, 10, 0), NOW)).toBe(
      new Date(2026, 5, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });

  it('includes the year for a chat from a different year', () => {
    expect(sessionTimeLabel(localIso(2025, 11, 20, 10, 0), NOW)).toBe(
      new Date(2025, 11, 20).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
  });
});

/** A local-time ISO-ish string (no Z) so Date.parse reads it as local wall-clock,
 *  matching how lastMessageAt is compared against a local `now`. */
function localIso(y: number, monthIdx: number, d: number, h: number, min: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(monthIdx + 1)}-${pad(d)}T${pad(h)}:${pad(min)}:00`;
}
