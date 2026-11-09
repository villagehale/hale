import { describe, expect, it } from 'vitest';
import { _internal } from './inference-tools';

/**
 * read_recent_memory feeds the memory-inferencer raw events. Rule #1: an event
 * scoped to a 13+ child must be redacted before the model sees it — raw payload
 * withheld, child scope dropped — while non-teen and family-wide (childId null)
 * events pass through so per-child facts can still be inferred for younger
 * children. Facts and episodes come from the shared prompt read, covered by
 * lib/memory/context-read.pglite.test.ts.
 */

const TEEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('redactEventsForTeens (rule #1)', () => {
  const stages = new Map<string, 'teenager' | 'toddler'>([
    [TEEN, 'teenager'],
    [TOT, 'toddler'],
  ]);

  it('passes non-teen and family-wide events through unchanged', () => {
    const events = [
      {
        childId: TOT,
        eventType: 'sleep.logged',
        payload: { hours: 11 },
        receivedAt: '2026-06-16T00:00:00.000Z',
      },
      {
        childId: null,
        eventType: 'calendar.synced',
        payload: { count: 3 },
        receivedAt: '2026-06-15T00:00:00.000Z',
      },
    ];
    expect(_internal.redactEventsForTeens(events, stages, ['Tamsin'])).toEqual(events);
  });

  it('redacts a teen-scoped event: raw payload withheld and child scope dropped', () => {
    const out = _internal.redactEventsForTeens(
      [
        {
          childId: TEEN,
          eventType: 'message.received',
          payload: { body: 'my teen got dumped by their boyfriend' },
          receivedAt: '2026-06-16T00:00:00.000Z',
        },
      ],
      stages,
      [],
    );
    const [event] = out;
    if (!event) throw new Error('expected one redacted event');
    expect(JSON.stringify(out)).not.toContain('boyfriend');
    expect(event.childId).toBeNull();
    // Coarse type survives — the model still knows the family has activity.
    expect(event.eventType).toBe('message.received');
  });

  it('redacts a family-wide event whose text names the teen, and keeps one that names nobody', () => {
    const named = {
      childId: null,
      eventType: 'message.received',
      payload: { body: 'Tamsin has a secret boyfriend' },
      receivedAt: '2026-06-16T00:00:00.000Z',
    };
    const unnamed = { ...named, payload: { body: 'the toddler slept eleven hours' } };
    const out = _internal.redactEventsForTeens([named, unnamed], stages, ['Tamsin']);
    expect(JSON.stringify(out)).not.toContain('boyfriend');
    expect(out[1]).toEqual(unnamed);
  });
});
