import { describe, expect, it, vi } from 'vitest';
import { buildInferenceTools, _internal } from './inference-tools';

/**
 * read_recent_memory feeds the memory-inferencer raw events/episodes/facts. Rule
 * #1: any row scoped to a 13+ child must be redacted before the model sees it —
 * raw payload/summary/value withheld, child scope dropped — while non-teen and
 * family-wide (childId null) rows pass through so per-child facts can still be
 * inferred for younger children.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-06-17T06:00:00Z');

// DOBs derived from the spec stage boundaries vs NOW, not from code output.
const TEEN_DOB = '2010-01-01'; // 16y → teenager (≥156 months)
const TOT_DOB = '2024-06-17'; // 24mo → toddler

describe('redactMemorySnapshotForTeens (rule #1)', () => {
  const stages = new Map<string, 'teenager' | 'toddler'>([
    [TEEN, 'teenager'],
    [TOT, 'toddler'],
  ]);

  it('passes non-teen and family-wide rows through unchanged', () => {
    const snapshot = {
      recentEvents: [
        { childId: TOT, eventType: 'sleep.logged', payload: { hours: 11 }, receivedAt: '2026-06-16T00:00:00.000Z' },
        { childId: null, eventType: 'calendar.synced', payload: { count: 3 }, receivedAt: '2026-06-15T00:00:00.000Z' },
      ],
      recentEpisodes: [
        { childId: TOT, episodeType: 'milestone', summary: 'first words', occurredAt: '2026-06-14T00:00:00.000Z' },
      ],
      currentFacts: [
        { childId: TOT, factType: 'routine', factKey: 'naps', factValue: { n: 2 }, confidence: 0.9 },
        { childId: null, factType: 'logistic', factKey: 'daycare', factValue: { name: 'Sunny' }, confidence: 0.8 },
      ],
    };
    const out = _internal.redactMemorySnapshotForTeens(snapshot, stages);
    expect(out).toEqual(snapshot);
  });

  it('redacts every teen-scoped row: raw value withheld and child scope dropped', () => {
    const out = _internal.redactMemorySnapshotForTeens(
      {
        recentEvents: [
          {
            childId: TEEN,
            eventType: 'message.received',
            payload: { body: 'my teen got dumped by their boyfriend' },
            receivedAt: '2026-06-16T00:00:00.000Z',
          },
        ],
        recentEpisodes: [
          { childId: TEEN, episodeType: 'concern', summary: 'self-harm worry raised in chat', occurredAt: '2026-06-14T00:00:00.000Z' },
        ],
        currentFacts: [
          { childId: TEEN, factType: 'medical', factKey: 'mood', factValue: { note: 'depressed about breakup' }, confidence: 0.85 },
        ],
      },
      stages,
    );

    const [event] = out.recentEvents;
    const [episode] = out.recentEpisodes;
    const [fact] = out.currentFacts;
    if (!event || !episode || !fact) throw new Error('expected one redacted row each');

    // Raw teen content is GONE from every row.
    expect(JSON.stringify(out)).not.toContain('boyfriend');
    expect(JSON.stringify(out)).not.toContain('self-harm');
    expect(JSON.stringify(out)).not.toContain('breakup');

    // Child scope dropped so no teen-specific fact can be inferred.
    expect(event.childId).toBeNull();
    expect(episode.childId).toBeNull();
    expect(fact.childId).toBeNull();

    // Coarse type survives — the model still knows the family has activity.
    expect(event.eventType).toBe('message.received');
    expect(episode.episodeType).toBe('concern');
    expect(fact.factType).toBe('medical');
  });

  it('redacts a teen fact whose raw content lives in the factKey (rule #1)', () => {
    const out = _internal.redactMemorySnapshotForTeens(
      {
        recentEvents: [],
        recentEpisodes: [],
        currentFacts: [
          {
            childId: TEEN,
            factType: 'medical',
            factKey: 'pregnancy scare with boyfriend',
            factValue: { note: 'asked about a clinic' },
            confidence: 0.9,
          },
        ],
      },
      stages,
    );

    const [fact] = out.currentFacts;
    if (!fact) throw new Error('expected one redacted teen fact');

    // The factKey is model/caller free text — sensitive teen content in it must
    // not survive into the inferencer's input (the residual VIL-150 closes).
    expect(JSON.stringify(out)).not.toContain('pregnancy');
    expect(JSON.stringify(out)).not.toContain('boyfriend');
    expect(fact.childId).toBeNull();
    // Coarse type still survives so the model knows the family has medical activity.
    expect(fact.factType).toBe('medical');
  });
});

/**
 * Fakes the read_recent_memory select chains by call order:
 *   0 children: from().where()
 *   1 events:   from().where().orderBy().limit()
 *   2 episodes: from().where().orderBy().limit()
 *   3 facts:    from().where()
 */
function fakeDb(rows: {
  children: { id: string; dateOfBirth: string }[];
  events: { childId: string | null; eventType: string; payload: unknown; receivedAt: Date }[];
  episodes: { childId: string | null; episodeType: string; summary: string; occurredAt: Date }[];
  facts: { childId: string | null; factType: string; factKey: string; factValue: unknown; confidence: number }[];
}) {
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const n = call++;
    if (n === 0) return { from: () => ({ where: async () => rows.children }) };
    if (n === 1)
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows.events }) }) }) };
    if (n === 2)
      return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows.episodes }) }) }) };
    return { from: () => ({ where: async () => rows.facts }) };
  });
  return { select } as never;
}

describe('read_recent_memory tool (rule #1)', () => {
  it('redacts a teen child and keeps a non-teen + family-wide row', async () => {
    const db = fakeDb({
      children: [
        { id: TEEN, dateOfBirth: TEEN_DOB },
        { id: TOT, dateOfBirth: TOT_DOB },
      ],
      events: [
        { childId: TEEN, eventType: 'message.received', payload: { body: 'teen secret about a boyfriend' }, receivedAt: new Date('2026-06-16T00:00:00Z') },
        { childId: TOT, eventType: 'sleep.logged', payload: { hours: 11 }, receivedAt: new Date('2026-06-15T00:00:00Z') },
        { childId: null, eventType: 'calendar.synced', payload: { count: 3 }, receivedAt: new Date('2026-06-14T00:00:00Z') },
      ],
      episodes: [],
      facts: [],
    });

    const tools = buildInferenceTools(db, NOW);
    const read = tools.find((t) => t.name === 'read_recent_memory');
    if (!read) throw new Error('read_recent_memory not registered');

    const result = (await read.handler({}, { familyId: FAMILY_ID, actor: 'system' })) as {
      recentEvents: { childId: string | null; eventType: string; payload: unknown }[];
    };

    expect(JSON.stringify(result)).not.toContain('boyfriend');

    const teenEvent = result.recentEvents.find((e) => e.eventType === 'message.received');
    if (!teenEvent) throw new Error('expected the teen event to survive as a redacted row');
    expect(teenEvent.childId).toBeNull();
    expect(teenEvent.payload).not.toMatchObject({ body: expect.anything() });

    const totEvent = result.recentEvents.find((e) => e.eventType === 'sleep.logged');
    expect(totEvent?.childId).toBe(TOT);
    expect(totEvent?.payload).toEqual({ hours: 11 });

    const familyEvent = result.recentEvents.find((e) => e.eventType === 'calendar.synced');
    expect(familyEvent?.childId).toBeNull();
    expect(familyEvent?.payload).toEqual({ count: 3 });
  });
});
