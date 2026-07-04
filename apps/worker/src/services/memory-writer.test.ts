import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@hale/db';
import type { ReviewerVerdict } from '@hale/types';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import {
  recordDrop,
  recordReviewerRejection,
  recordReviewerVerdict,
  recordExecution,
  recordDiscovery,
  recordRoutineProposal,
} from './memory-writer.js';

const familyId = '11111111-1111-4111-8111-111111111111';
const eventId = '33333333-3333-4333-8333-333333333333';
const actionId = '22222222-2222-4222-8222-222222222222';
const reviewerMetrics: AgentRunMetrics = {
  agentName: 'reviewer',
  modelUsed: 'claude-sonnet-4-6',
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0.001,
  latencyMs: 200,
};

/**
 * A chainable query-builder stub: every terminal builder method (.returning,
 * .limit, .onConflictDoNothing, .where) resolves to `rows`. .insert records the
 * target table so the test can count audit_log writes. The point of these tests
 * is the single-writer invariant — exactly one audit_log row per transition —
 * not the SQL itself.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'set',
    'where',
    'from',
    'values',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'returning',
    'limit',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  // Make the chain awaitable (drizzle builders are thenable) and resolve to rows.
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

interface StubResult {
  database: Database;
  auditInserts: () => number;
  insertedTables: () => string[];
  /** Rows passed to insert(village_candidates).values(...), so a test can assert
   * the persisted freshness fields (cadence / event_date / seasons). */
  candidateInserts: () => Record<string, unknown>[];
  /** The `.set(...)` payloads of update(village_candidates) calls — the supersede
   * step. Proves the prior set is SOFT-retired (superseded_at stamped), never
   * hard-deleted (no .delete is ever called). */
  candidateUpdates: () => Record<string, unknown>[];
}

/**
 * Builds a fake Database whose .transaction(cb) runs cb synchronously against a
 * tx stub. selectRows is what any .select() resolves to (used for the
 * familyId lookup inside reviewer/execution transitions).
 */
function stubDb(selectRows: unknown[] = [{ familyId }]): StubResult {
  const insertedTables: string[] = [];
  const candidateInserts: Record<string, unknown>[] = [];
  const candidateUpdates: Record<string, unknown>[] = [];

  const tx = {
    insert: vi.fn((table: unknown) => {
      insertedTables.push(table === schema.auditLog ? 'audit_log' : 'other');
      if (table === schema.villageCandidates) {
        const chain = builder([{ id: actionId }]);
        (chain as { values: unknown }).values = vi.fn((rows: unknown) => {
          const list = Array.isArray(rows) ? rows : [rows];
          candidateInserts.push(...(list as Record<string, unknown>[]));
          return chain;
        });
        return chain;
      }
      return builder([{ id: actionId }]);
    }),
    update: vi.fn((table: unknown) => {
      const chain = builder([]);
      if (table === schema.villageCandidates) {
        (chain as { set: unknown }).set = vi.fn((payload: Record<string, unknown>) => {
          candidateUpdates.push(payload);
          return chain;
        });
      }
      return chain;
    }),
    // A spy that must never fire: supersede is a SOFT stamp, so an endorsed /
    // shared candidate is never hard-deleted (its endorsement + public token
    // survive). A call here would throw the test red.
    delete: vi.fn(() => {
      throw new Error('recordDiscovery must never DELETE candidates (soft supersede)');
    }),
    select: vi.fn(() => builder(selectRows)),
  };

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;

  return {
    database,
    auditInserts: () => insertedTables.filter((t) => t === 'audit_log').length,
    insertedTables: () => insertedTables,
    candidateInserts: () => candidateInserts,
    candidateUpdates: () => candidateUpdates,
  };
}

describe('recordTransition single-writer — exactly one audit row per transition', () => {
  it('recordDrop(low_confidence) writes exactly one audit row in one transaction', async () => {
    const s = stubDb();
    await recordDrop({ familyId, eventId, reason: 'low_confidence', detail: {} }, s.database);

    expect((s.database.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(s.auditInserts()).toBe(1);
  });

  it('recordDrop(unknown_action_type) writes exactly one audit row', async () => {
    const s = stubDb();
    await recordDrop(
      { familyId, eventId, reason: 'unknown_action_type', detail: { actionType: 'bogus' } },
      s.database,
    );
    expect(s.auditInserts()).toBe(1);
  });

  it('recordDrop(needs_human) writes exactly one audit row', async () => {
    const s = stubDb();
    await recordDrop({ familyId, eventId, reason: 'needs_human', detail: {} }, s.database);
    expect(s.auditInserts()).toBe(1);
  });

  it('recordReviewerRejection writes exactly one audit row', async () => {
    const s = stubDb();
    await recordReviewerRejection(
      { familyId, actionId, verdictKind: 'reject', rationale: 'PII leak' },
      s.database,
    );
    expect(s.auditInserts()).toBe(1);
  });

  it('recordReviewerVerdict pairs the domain update with one audit row atomically', async () => {
    const s = stubDb();
    const verdict: ReviewerVerdict = { kind: 'flag_for_human', rationale: 'unsure', toolResults: [] };
    await recordReviewerVerdict({ actionId, verdict, reviewerMetrics }, s.database);

    expect((s.database.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(s.auditInserts()).toBe(1);
  });

  it('recordExecution pairs the domain update with one audit row atomically', async () => {
    const s = stubDb();
    await recordExecution({ actionId, result: { ok: true }, ok: true }, s.database);

    expect((s.database.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(s.auditInserts()).toBe(1);
  });

  it('throws (rolls back) when the action row is missing — no partial write', async () => {
    const s = stubDb([]); // familyId lookup returns nothing
    await expect(
      recordExecution({ actionId, result: {}, ok: false }, s.database),
    ).rejects.toThrow(/not found/);
    expect(s.auditInserts()).toBe(0);
  });

  it('recordDiscovery with candidates writes exactly one audit row in one transaction', async () => {
    const s = stubDb();
    await recordDiscovery(
      {
        familyId,
        areaCoarse: 'Toronto',
        provider: 'eventbrite',
        candidates: [
          {
            title: 'Storytime',
            kind: 'library',
            summary: 'Weekly toddler storytime',
            source: 'eventbrite',
            confidence: 0.9,
            childId: null,
          },
        ],
      },
      s.database,
    );

    expect(s.database.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(s.auditInserts()).toBe(1);
  });

  it('recordDiscovery REPLACES: soft-supersedes the prior set and persists cadence/event_date/seasons', async () => {
    const s = stubDb();
    await recordDiscovery(
      {
        familyId,
        areaCoarse: 'Toronto',
        provider: 'eventbrite',
        candidates: [
          {
            title: 'Summer camp',
            kind: 'program',
            summary: 'A seasonal day camp',
            source: 'eventbrite',
            confidence: 0.9,
            cadence: 'seasonal',
            seasons: ['summer'],
            childId: null,
          },
          {
            title: 'Author visit',
            kind: 'library',
            summary: 'A one-day author reading',
            source: 'eventbrite',
            confidence: 0.8,
            cadence: 'one-time',
            eventDate: '2026-09-12',
            childId: null,
          },
        ],
      },
      s.database,
    );

    // The prior active set is soft-retired by exactly one update that stamps ONLY
    // superseded_at — a shared/endorsed row survives (no hard delete, share token
    // untouched).
    const updates = s.candidateUpdates();
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0] as Record<string, unknown>)).toEqual(['supersededAt']);
    expect((updates[0] as Record<string, unknown>).supersededAt).toBeInstanceOf(Date);

    // The freshness fields the provider supplied are persisted on the new rows.
    const inserted = s.candidateInserts();
    expect(inserted[0]).toMatchObject({ cadence: 'seasonal', seasons: ['summer'] });
    expect(inserted[0]?.eventDate).toBeUndefined();
    expect(inserted[1]).toMatchObject({ cadence: 'one-time', eventDate: '2026-09-12' });
    expect(inserted[1]?.seasons).toBeUndefined();
  });

  it('recordDiscovery with no candidates writes zero candidate rows and zero audit rows', async () => {
    const s = stubDb();
    const result = await recordDiscovery(
      { familyId, areaCoarse: 'Toronto', provider: 'eventbrite', candidates: [] },
      s.database,
    );

    expect(result.insertedCount).toBe(0);
    expect(s.database.transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(s.insertedTables()).toEqual([]);
    expect(s.auditInserts()).toBe(0);
  });

  it('recordRoutineProposal writes exactly one audit row and returns the proposal id', async () => {
    const s = stubDb();
    const result = await recordRoutineProposal(
      {
        familyId,
        weekOf: '2026-06-15',
        items: [{ title: 'Storytime', kind: 'library', childId: null, stageNote: 'toddler' }],
      },
      s.database,
    );

    expect(s.database.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(s.auditInserts()).toBe(1);
    expect(result.proposalId).toBe(actionId);
  });
});
