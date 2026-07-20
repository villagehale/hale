import { describe, expect, it } from 'vitest';
import type { TimelineMessage } from '~/lib/coach/conversation';
import {
  type Turn,
  buildCoachRequest,
  filterTurns,
  readNdjson,
  timelineToTurns,
} from './use-ask-hale';

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

  it('omits attachmentIds when there are none, and carries them when present', () => {
    expect(buildCoachRequest('here you go', 'conv-7', null, [])).not.toHaveProperty('attachmentIds');
    expect(buildCoachRequest('here you go', 'conv-7', null, ['att-1', 'att-2'])).toEqual({
      question: 'here you go',
      conversationId: 'conv-7',
      attachmentIds: ['att-1', 'att-2'],
    });
  });
});

describe('timelineToTurns', () => {
  it('maps persisted timeline turns to client turns, dropping live stream metadata', () => {
    const timeline: TimelineMessage[] = [
      {
        id: 'm1',
        role: 'user',
        content: 'when do solids start?',
        childId: 'tot',
        topic: 'feeding',
        createdAt: '2026-07-19T12:00:00.000Z',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Around six months.',
        childId: 'tot',
        topic: 'feeding',
        createdAt: '2026-07-19T12:00:05.000Z',
      },
    ];
    expect(timelineToTurns(timeline)).toEqual([
      { id: 'm1', role: 'user', body: 'when do solids start?', childId: 'tot', topic: 'feeding' },
      { id: 'm2', role: 'assistant', body: 'Around six months.', childId: 'tot', topic: 'feeding' },
    ]);
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

/** A ReadableStream of UTF-8 bytes from the given string slices — one slice per chunk. */
function byteStream(slices: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const slice of slices) controller.enqueue(encoder.encode(slice));
      controller.close();
    },
  });
}

describe('readNdjson', () => {
  it('parses one event per newline-terminated line', async () => {
    const events: unknown[] = [];
    await readNdjson(
      byteStream([
        '{"type":"delta","text":"a"}\n{"type":"delta","text":"b"}\n{"type":"done","conversationId":"c","actionIntents":[]}\n',
      ]),
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'done', conversationId: 'c', actionIntents: [] },
    ]);
  });

  it('reassembles a JSON line split across chunk boundaries', async () => {
    // The network can split a line mid-token; the buffer must stitch it back before parsing.
    const events: unknown[] = [];
    await readNdjson(byteStream(['{"type":"del', 'ta","text":"hel', 'lo"}\n']), (e) =>
      events.push(e),
    );
    expect(events).toEqual([{ type: 'delta', text: 'hello' }]);
  });

  it('flushes a final line that has no trailing newline', async () => {
    const events: unknown[] = [];
    await readNdjson(byteStream(['{"type":"error"}']), (e) => events.push(e));
    expect(events).toEqual([{ type: 'error' }]);
  });
});

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
