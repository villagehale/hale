import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from './api-types';
import { formatSessionTime, groupConversations, transcriptToMessages } from './ask-history';

/**
 * Expected values are derived from the spec (Feature 3): Today = the same LOCAL day
 * as an injected `now`; the sub line is a 12-hour clock for today and a "Mon D"
 * label for earlier; the transcript maps user→user / assistant→completed-hale and
 * drops any other role. Fixtures are built with LOCAL Date constructors and passed
 * as ISO instants, so the round-trip is stable in whatever TZ the runner uses.
 */

function conv(id: string, lastMessageAt: string): ConversationSummary {
  return { id, title: `title-${id}`, noteKey: null, lastMessageAt, messageCount: 2 };
}

describe('groupConversations', () => {
  const now = new Date(2026, 6, 19, 12, 0, 0); // Jul 19 2026, noon local

  it('splits Today (same local day) from Earlier', () => {
    const list = [
      conv('a', new Date(2026, 6, 19, 9, 30).toISOString()), // today
      conv('b', new Date(2026, 6, 18, 23, 30).toISOString()), // yesterday
      conv('c', new Date(2026, 6, 19, 0, 0).toISOString()), // today, midnight
      conv('d', new Date(2026, 5, 1, 12, 0).toISOString()), // last month
    ];
    const { today, earlier } = groupConversations(list, now);
    expect(today.map((c) => c.id)).toEqual(['a', 'c']);
    expect(earlier.map((c) => c.id)).toEqual(['b', 'd']);
  });

  it('places the last instant before local midnight in Earlier (boundary)', () => {
    const list = [
      conv('mid', new Date(2026, 6, 19, 0, 0, 0).toISOString()), // 00:00:00 today
      conv('before', new Date(2026, 6, 18, 23, 59, 59).toISOString()), // 23:59:59 yesterday
    ];
    const { today, earlier } = groupConversations(list, now);
    expect(today.map((c) => c.id)).toEqual(['mid']);
    expect(earlier.map((c) => c.id)).toEqual(['before']);
  });

  it('preserves input order within each group', () => {
    const list = [
      conv('t1', new Date(2026, 6, 19, 18, 0).toISOString()),
      conv('e1', new Date(2026, 6, 10, 8, 0).toISOString()),
      conv('t2', new Date(2026, 6, 19, 6, 0).toISOString()),
      conv('e2', new Date(2026, 6, 9, 8, 0).toISOString()),
    ];
    const { today, earlier } = groupConversations(list, now);
    expect(today.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(earlier.map((c) => c.id)).toEqual(['e1', 'e2']);
  });
});

describe('formatSessionTime', () => {
  const now = new Date(2026, 6, 19, 12, 0, 0);

  it('formats a same-day stamp as a 12-hour clock time', () => {
    expect(formatSessionTime(new Date(2026, 6, 19, 17, 12).toISOString(), now)).toBe('5:12 PM');
    expect(formatSessionTime(new Date(2026, 6, 19, 9, 5).toISOString(), now)).toBe('9:05 AM');
    expect(formatSessionTime(new Date(2026, 6, 19, 0, 0).toISOString(), now)).toBe('12:00 AM');
    expect(formatSessionTime(new Date(2026, 6, 19, 12, 0).toISOString(), now)).toBe('12:00 PM');
  });

  it('formats an earlier stamp as month abbreviation + day', () => {
    expect(formatSessionTime(new Date(2026, 6, 14, 8, 0).toISOString(), now)).toBe('Jul 14');
    expect(formatSessionTime(new Date(2026, 0, 3, 23, 0).toISOString(), now)).toBe('Jan 3');
  });
});

describe('transcriptToMessages', () => {
  it('maps user→bubble and assistant→completed hale turn, preserving order', () => {
    const turns = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: '2026-07-19T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'hello', createdAt: '2026-07-19T10:00:01.000Z' },
      { id: 'm3', role: 'user', content: 'thanks', createdAt: '2026-07-19T10:00:02.000Z' },
    ];
    const out = transcriptToMessages(turns);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out[0]).toEqual({ id: 'm1', role: 'user', text: 'hi' });
    expect(out[1]).toEqual({
      id: 'm2',
      role: 'hale',
      text: 'hello',
      trail: [],
      activity: [],
      actionIntents: [],
      streaming: false,
      errored: false,
    });
  });

  it('skips turns with an unrecognized role', () => {
    const turns = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 'x' },
      { id: 'm2', role: 'system', content: 'system prompt', createdAt: 'x' },
      { id: 'm3', role: 'tool', content: '{}', createdAt: 'x' },
      { id: 'm4', role: 'assistant', content: 'ok', createdAt: 'x' },
    ];
    expect(transcriptToMessages(turns).map((m) => m.id)).toEqual(['m1', 'm4']);
  });

  it('returns an empty list for an empty transcript', () => {
    expect(transcriptToMessages([])).toEqual([]);
  });
});
