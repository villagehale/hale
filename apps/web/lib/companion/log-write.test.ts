import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  FEED_EPISODE,
  HEALTH_DONE_EPISODE,
  type MarkDoneInput,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from './log-types.js';
import { buildDoneEpisodeInsert, buildEpisodeInsert, writeEpisode } from './log-write.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const AUTHOR_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-06-18T12:00:00Z');

describe('buildEpisodeInsert', () => {
  it('shapes a feed episode with amountMl in the payload, a numeric summary, and the author stamped', () => {
    const input: QuickLogInput = { kind: FEED_EPISODE, childId: CHILD_ID, amountMl: 120 };

    expect(buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID)).toEqual({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'feed',
      summary: 'Fed 120 ml',
      payload: { amountMl: 120 },
    });
  });

  it('shapes a nap episode with durationMin in the payload', () => {
    const input: QuickLogInput = { kind: NAP_EPISODE, childId: CHILD_ID, durationMin: 45 };

    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);

    expect(episode.episodeType).toBe('nap');
    expect(episode.summary).toBe('Napped 45 min');
    expect(episode.payload).toEqual({ durationMin: 45 });
  });

  it('shapes a milestone episode carrying the milestone text as summary and payload', () => {
    const input: QuickLogInput = {
      kind: MILESTONE_EPISODE,
      childId: CHILD_ID,
      milestone: 'rolled over',
    };

    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);

    expect(episode.episodeType).toBe('milestone');
    expect(episode.summary).toBe('rolled over');
    expect(episode.payload).toEqual({ milestone: 'rolled over' });
  });

  it('includes an optional note in the feed payload when given', () => {
    const input: QuickLogInput = {
      kind: FEED_EPISODE,
      childId: CHILD_ID,
      amountMl: 90,
      note: 'spit up a little',
    };

    expect(buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID).payload).toEqual({
      amountMl: 90,
      note: 'spit up a little',
    });
  });
});

describe('buildDoneEpisodeInsert', () => {
  it('marks a milestone done as the SAME row a quick-log milestone writes', () => {
    const input: MarkDoneInput = {
      target: 'milestone',
      childId: CHILD_ID,
      what: 'Walks independently',
    };

    const done = buildDoneEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);
    const quickLog = buildEpisodeInsert(
      { kind: MILESTONE_EPISODE, childId: CHILD_ID, milestone: 'Walks independently' },
      FAMILY_ID,
      NOW,
      AUTHOR_ID,
    );

    expect(done).toEqual(quickLog);
    expect(done.episodeType).toBe('milestone');
    expect(done.payload).toEqual({ milestone: 'Walks independently' });
  });

  it('marks a health item done as a health_done episode carrying the stable key', () => {
    const input: MarkDoneInput = {
      target: 'health',
      childId: CHILD_ID,
      what: '4-month well-baby visit',
      healthKey: '4-well_child_visit',
    };

    expect(buildDoneEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID)).toEqual({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: HEALTH_DONE_EPISODE,
      summary: '4-month well-baby visit — done',
      payload: { healthKey: '4-well_child_visit', what: '4-month well-baby visit' },
    });
  });
});

/**
 * Chainable builder stub: .returning() resolves to the configured rows; .values()
 * records its payload for assertion. Mirrors the onboarding persist test's stub.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'where', 'from', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

const EPISODE_ROW_ID = '44444444-4444-4444-8444-444444444444';

function stubTxDb() {
  const insertedTables: string[] = [];
  const tableName = (table: unknown): string => {
    if (table === schema.familyMemoryEpisodes) return 'family_memory_episodes';
    if (table === schema.auditLog) return 'audit_log';
    return 'other';
  };
  const tx = {
    insert: vi.fn((table: unknown) => {
      insertedTables.push(tableName(table));
      return builder(table === schema.familyMemoryEpisodes ? [{ id: EPISODE_ROW_ID }] : []);
    }),
  };
  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;
  return { database, insertedTables: () => insertedTables, txInsert: () => tx.insert };
}

function valuesFor(s: ReturnType<typeof stubTxDb>, table: unknown): Record<string, unknown> {
  const idx = s.txInsert().mock.calls.findIndex((c) => c[0] === table);
  const chain = s.txInsert().mock.results[idx]?.value as { values: ReturnType<typeof vi.fn> };
  return chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('writeEpisode', () => {
  it('inserts the episode and an audit_log row in one transaction (rule #6)', async () => {
    const s = stubTxDb();

    await writeEpisode(
      s.database,
      buildEpisodeInsert(
        { kind: FEED_EPISODE, childId: CHILD_ID, amountMl: 100 },
        FAMILY_ID,
        NOW,
        AUTHOR_ID,
      ),
    );

    expect(s.insertedTables()).toEqual(['family_memory_episodes', 'audit_log']);

    expect(valuesFor(s, schema.familyMemoryEpisodes)).toMatchObject({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      episodeType: 'feed',
      summary: 'Fed 100 ml',
      payload: { amountMl: 100 },
    });

    expect(valuesFor(s, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: FAMILY_ID,
      actionTaken: 'quick_log_feed',
      targetTable: 'family_memory_episodes',
      targetId: EPISODE_ROW_ID,
    });
  });

  it('writes an audited health_done episode when marking a health item done (rule #6)', async () => {
    const s = stubTxDb();

    await writeEpisode(
      s.database,
      buildDoneEpisodeInsert(
        {
          target: 'health',
          childId: CHILD_ID,
          what: '4-month well-baby visit',
          healthKey: '4-well_child_visit',
        },
        FAMILY_ID,
        NOW,
        AUTHOR_ID,
      ),
    );

    expect(s.insertedTables()).toEqual(['family_memory_episodes', 'audit_log']);
    expect(valuesFor(s, schema.auditLog)).toMatchObject({
      familyId: FAMILY_ID,
      actor: FAMILY_ID,
      actionTaken: 'quick_log_health_done',
      targetTable: 'family_memory_episodes',
      targetId: EPISODE_ROW_ID,
    });
  });
});
