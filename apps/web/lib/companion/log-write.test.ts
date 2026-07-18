import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  DIAPER_EPISODE,
  type DiaperKind,
  FEED_EPISODE,
  HEALTH_DONE_EPISODE,
  type MarkDoneInput,
  MEASUREMENT_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from './log-types.js';
import {
  buildDoneEpisodeInsert,
  buildEpisodeInsert,
  resolveFeed,
  resolveNap,
  writeEpisode,
} from './log-write.js';

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

  it('shapes a qualitative feed with feedAmount in the payload and prototype-worded summary', () => {
    const input: QuickLogInput = { kind: FEED_EPISODE, childId: CHILD_ID, feedAmount: 'most' };

    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);
    expect(episode.episodeType).toBe('feed');
    expect(episode.summary).toBe('Fed — most of it');
    expect(episode.payload).toEqual({ feedAmount: 'most' });
  });

  it('words each qualitative amount from the prototype language (derived from the spec)', () => {
    const cases: [('little' | 'half' | 'most' | 'all'), string][] = [
      ['little', 'Fed — a little'],
      ['half', 'Fed — half'],
      ['most', 'Fed — most of it'],
      ['all', 'Fed — all of it'],
    ];
    for (const [feedAmount, summary] of cases) {
      const episode = buildEpisodeInsert(
        { kind: FEED_EPISODE, childId: CHILD_ID, feedAmount },
        FAMILY_ID,
        NOW,
        AUTHOR_ID,
      );
      expect(episode.summary, feedAmount).toBe(summary);
    }
  });

  it('appends the feedKind to a qualitative summary when given', () => {
    const episode = buildEpisodeInsert(
      { kind: FEED_EPISODE, childId: CHILD_ID, feedAmount: 'most', feedKind: 'solid' },
      FAMILY_ID,
      NOW,
      AUTHOR_ID,
    );
    expect(episode.summary).toBe('Fed — most of it (solid)');
    expect(episode.payload).toEqual({ feedAmount: 'most', feedKind: 'solid' });
  });

  it('shapes a nap episode with durationMin in the payload', () => {
    const input: QuickLogInput = { kind: NAP_EPISODE, childId: CHILD_ID, durationMin: 45 };

    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);

    expect(episode.episodeType).toBe('nap');
    expect(episode.summary).toBe('Napped 45 min');
    expect(episode.payload).toEqual({ durationMin: 45 });
  });

  it('shapes a nap from a resolved window duration, keeping the bounds in the payload', () => {
    const input: QuickLogInput = {
      kind: NAP_EPISODE,
      childId: CHILD_ID,
      startAt: '2026-06-18T09:00:00Z',
      endAt: '2026-06-18T10:30:00Z',
    };

    // The boundary derived 90 min from the window (resolveNapWindow); the pure
    // builder receives it and stamps the summary + payload from it.
    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID, 90);

    expect(episode.summary).toBe('Napped 90 min');
    expect(episode.payload).toEqual({
      durationMin: 90,
      startAt: '2026-06-18T09:00:00Z',
      endAt: '2026-06-18T10:30:00Z',
    });
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

  it('shapes a weight measurement with an honest summary and the fixed kg unit in payload', () => {
    const input: QuickLogInput = {
      kind: MEASUREMENT_EPISODE,
      childId: CHILD_ID,
      measureKind: 'weight',
      value: 10.4,
    };

    expect(buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID)).toEqual({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'measurement',
      summary: 'Weighed 10.4 kg',
      payload: { measureKind: 'weight', value: 10.4, unit: 'kg' },
    });
  });

  it('shapes a height measurement with the fixed cm unit (never a client-sent unit)', () => {
    const input: QuickLogInput = {
      kind: MEASUREMENT_EPISODE,
      childId: CHILD_ID,
      measureKind: 'height',
      value: 62,
    };

    const episode = buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID);

    expect(episode.episodeType).toBe('measurement');
    expect(episode.summary).toBe('Height 62 cm');
    expect(episode.payload).toEqual({ measureKind: 'height', value: 62, unit: 'cm' });
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

  it('shapes a diaper episode with the kind in the payload and a capitalized summary', () => {
    const input: QuickLogInput = { kind: DIAPER_EPISODE, childId: CHILD_ID, diaperKind: 'wet' };

    expect(buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID)).toEqual({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'diaper',
      summary: 'Wet diaper',
      payload: { diaperKind: 'wet' },
    });
  });

  it('summarizes every diaper kind as "<Kind> diaper" (label derived from the spec)', () => {
    const cases: [DiaperKind, string][] = [
      ['wet', 'Wet diaper'],
      ['dirty', 'Dirty diaper'],
      ['mixed', 'Mixed diaper'],
      ['dry', 'Dry diaper'],
    ];

    for (const [diaperKind, summary] of cases) {
      const episode = buildEpisodeInsert(
        { kind: DIAPER_EPISODE, childId: CHILD_ID, diaperKind },
        FAMILY_ID,
        NOW,
        AUTHOR_ID,
      );
      expect(episode.episodeType).toBe('diaper');
      expect(episode.summary).toBe(summary);
      expect(episode.payload).toEqual({ diaperKind });
    }
  });

  it('includes an optional note in the diaper payload when given', () => {
    const input: QuickLogInput = {
      kind: DIAPER_EPISODE,
      childId: CHILD_ID,
      diaperKind: 'dirty',
      note: 'blowout',
    };

    expect(buildEpisodeInsert(input, FAMILY_ID, NOW, AUTHOR_ID).payload).toEqual({
      diaperKind: 'dirty',
      note: 'blowout',
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

describe('resolveNap — the boundary guard now that the schema no longer requires durationMin', () => {
  it('rejects a nap carrying NEITHER a duration nor a window (the case the schema stopped catching)', () => {
    // napSchema is a plain ZodObject with an OPTIONAL durationMin, so {kind, childId}
    // parses. resolveNap is the only thing standing between that and buildEpisodeInsert
    // throwing (missing durationMin and window) → an unhandled 500. It must reject.
    const r = resolveNap({ kind: NAP_EPISODE, childId: CHILD_ID }, NOW);
    expect(r).toEqual({ ok: false, error: 'enter how long the nap was, or its start and end' });
  });

  it('rejects a nap with a lone bound (an incomplete window, no fallback duration)', () => {
    const r = resolveNap(
      { kind: NAP_EPISODE, childId: CHILD_ID, startAt: '2026-06-18T09:00:00Z' },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('passes a plain-duration nap through, returning the direct duration', () => {
    // No window → resolveNap falls back to the direct durationMin (45) and returns
    // it, which buildEpisodeInsert then uses. (Only a NON-nap input yields undefined.)
    expect(resolveNap({ kind: NAP_EPISODE, childId: CHILD_ID, durationMin: 45 }, NOW)).toEqual({
      ok: true,
      durationMin: 45,
    });
  });

  it('derives the duration from a full window', () => {
    const r = resolveNap(
      {
        kind: NAP_EPISODE,
        childId: CHILD_ID,
        startAt: '2026-06-18T09:00:00Z',
        endAt: '2026-06-18T10:30:00Z',
      },
      NOW,
    );
    expect(r).toEqual({ ok: true, durationMin: 90 });
  });
});

describe('resolveFeed — the boundary guard for the additive qualitative amount', () => {
  it('rejects a feed carrying NEITHER amountMl nor feedAmount (the case the schema stopped catching)', () => {
    // feedSchema now has BOTH amount fields optional (so it stays a plain ZodObject in
    // the union), so {kind, childId} parses. resolveFeed is the boundary that keeps a
    // no-amount feed from reaching buildEpisodeInsert.
    expect(resolveFeed({ kind: FEED_EPISODE, childId: CHILD_ID })).toEqual({
      ok: false,
      error: 'enter how much — a millilitre amount or how much they took',
    });
  });

  it('passes a numeric feed through', () => {
    expect(resolveFeed({ kind: FEED_EPISODE, childId: CHILD_ID, amountMl: 120 })).toEqual({
      ok: true,
    });
  });

  it('passes a qualitative feed through', () => {
    expect(resolveFeed({ kind: FEED_EPISODE, childId: CHILD_ID, feedAmount: 'half' })).toEqual({
      ok: true,
    });
  });

  it('is a no-op (ok) for a non-feed input', () => {
    expect(resolveFeed({ kind: NAP_EPISODE, childId: CHILD_ID, durationMin: 30 })).toEqual({
      ok: true,
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
