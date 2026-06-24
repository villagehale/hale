import { describe, expect, it } from 'vitest';
import { buildCoachRequest, filterTurns, type Turn } from './use-ask-hale';

/**
 * The continuous-companion shell's two pure seams:
 *  - buildCoachRequest: the running conversationId continues the ONE family
 *    conversation; the focused child scopes the turn; null values are omitted.
 *  - filterTurns: the timeline is filterable by child, topic, and free-text search
 *    over the full history — the searchable relationship timeline.
 */
describe('buildCoachRequest', () => {
  it('omits conversationId + focus on the first whole-family turn', () => {
    expect(buildCoachRequest('when do I start solids?', null, null)).toEqual({
      question: 'when do I start solids?',
    });
  });

  it('carries the conversationId forward so the same conversation continues', () => {
    expect(buildCoachRequest('and what about allergens?', 'conv-7', null)).toEqual({
      question: 'and what about allergens?',
      conversationId: 'conv-7',
    });
  });

  it('carries the focused child so the turn is per-child scoped', () => {
    expect(buildCoachRequest('is she sleeping enough?', 'conv-7', 'child-1')).toEqual({
      question: 'is she sleeping enough?',
      conversationId: 'conv-7',
      focusedChildId: 'child-1',
    });
  });
});

function turn(over: Partial<Turn> & { id: string }): Turn {
  return { role: 'user', body: '', childId: null, topic: null, ...over };
}

const TIMELINE: Turn[] = [
  turn({ id: 'a', body: 'when do I start solids?', childId: 'tot', topic: 'feeding' }),
  turn({ id: 'b', body: 'how many naps for a toddler?', childId: 'tot', topic: 'sleep' }),
  turn({ id: 'c', body: 'what is good this weekend?', childId: null, topic: 'activities' }),
  turn({ id: 'd', body: 'screen time for my teen?', childId: 'teen', topic: 'behavior' }),
];

describe('filterTurns', () => {
  it('shows the whole family when no child is focused', () => {
    expect(filterTurns(TIMELINE, null, null, '').map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shows only the focused child’s turns', () => {
    expect(filterTurns(TIMELINE, 'tot', null, '').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('filters by topic across the history', () => {
    expect(filterTurns(TIMELINE, null, 'sleep', '').map((t) => t.id)).toEqual(['b']);
  });

  it('searches the timeline text case-insensitively', () => {
    expect(filterTurns(TIMELINE, null, null, 'SOLIDS').map((t) => t.id)).toEqual(['a']);
  });

  it('combines child + topic + search filters', () => {
    expect(filterTurns(TIMELINE, 'tot', 'sleep', 'naps').map((t) => t.id)).toEqual(['b']);
    expect(filterTurns(TIMELINE, 'tot', 'feeding', 'naps')).toEqual([]);
  });
});
