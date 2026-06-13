import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@hearth/db';
import type { ReviewerVerdict } from '@hearth/types';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import {
  recordDrop,
  recordReviewerRejection,
  recordReviewerVerdict,
  recordExecution,
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
  for (const m of ['set', 'where', 'from', 'values', 'onConflictDoNothing', 'returning', 'limit']) {
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
}

/**
 * Builds a fake Database whose .transaction(cb) runs cb synchronously against a
 * tx stub. selectRows is what any .select() resolves to (used for the
 * familyId lookup inside reviewer/execution transitions).
 */
function stubDb(selectRows: unknown[] = [{ familyId }]): StubResult {
  const insertedTables: string[] = [];

  const tx = {
    insert: vi.fn((table: unknown) => {
      insertedTables.push(table === schema.auditLog ? 'audit_log' : 'other');
      return builder([{ id: actionId }]);
    }),
    update: vi.fn(() => builder([])),
    select: vi.fn(() => builder(selectRows)),
  };

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;

  return {
    database,
    auditInserts: () => insertedTables.filter((t) => t === 'audit_log').length,
    insertedTables: () => insertedTables,
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
});
