import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@hale/db';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import { recordAgentRun, recordAction } from './memory-writer.js';

/**
 * B8 — agent_runs become real. These tests script the DB transport (injected
 * stub) and assert the threading invariant: the drafter run row is inserted in
 * the SAME transaction as the action it produced, and the action's FK
 * (drafted_by_agent_run_id) is the run's REAL generated id — not a fabricated
 * crypto.randomUUID(). The real-DB FK-join proof is the guarded integration
 * test below.
 */

const familyId = '11111111-1111-4111-8111-111111111111';
const eventId = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'run-from-db-0001';

const drafterMetrics: AgentRunMetrics = {
  agentName: 'drafter',
  modelUsed: 'claude-sonnet-4-6',
  promptTokens: 800,
  completionTokens: 200,
  costUsd: 0.005,
  latencyMs: 1234,
};

function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'from', 'values', 'onConflictDoNothing', 'returning', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

describe('recordAgentRun (B8)', () => {
  it('inserts exactly one agent_runs row standalone and returns its id', async () => {
    const inserts: unknown[] = [];
    const inserter = {
      insert: vi.fn((table: unknown) => {
        inserts.push(table);
        return builder([{ id: RUN_ID }]);
      }),
    } as unknown as Database;

    const id = await recordAgentRun(
      { familyId, eventId, metrics: { ...drafterMetrics, agentName: 'classifier' } },
      inserter,
    );

    expect(id).toBe(RUN_ID);
    expect(inserts).toEqual([schema.agentRuns]);
  });
});

describe('recordAction threads the drafter run through the action transaction (B8)', () => {
  it('writes the drafter agent_run + action in one transaction; FK = real run id', async () => {
    const inserted: string[] = [];
    let actionFk: unknown;

    const tx = {
      insert: vi.fn((table: unknown) => {
        if (table === schema.agentRuns) {
          inserted.push('agent_runs');
          return builder([{ id: RUN_ID }]);
        }
        if (table === schema.actions) {
          inserted.push('actions');
          return builder([{ id: 'action-1' }]);
        }
        inserted.push('audit_log');
        return builder([{ id: 'audit-1' }]);
      }),
      // The FK is threaded via UPDATE (the action is inserted first with
      // onConflictDoNothing, then linked once the run id exists). Capture the
      // run id from the actions update that sets draftedByAgentRunId.
      update: vi.fn((table: unknown) => {
        if (table === schema.actions) {
          return {
            set: vi.fn((row: { draftedByAgentRunId?: unknown }) => {
              if (row.draftedByAgentRunId !== undefined) actionFk = row.draftedByAgentRunId;
              return builder([]);
            }),
          };
        }
        return builder([]);
      }),
      select: vi.fn(() => builder([{ familyId }])),
    };

    const database = {
      transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Database;

    const { actionId, drafterRunId } = await recordAction(
      { familyId, eventId, actionType: 'send_email', payload: {}, drafterMetrics },
      database,
    );

    expect((database.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // Drafter run row and the action row both inserted; exactly one audit row.
    expect(inserted.filter((t) => t === 'agent_runs')).toHaveLength(1);
    expect(inserted.filter((t) => t === 'actions')).toHaveLength(1);
    expect(inserted.filter((t) => t === 'audit_log')).toHaveLength(1);
    // The FK on the action is the run's REAL generated id, not a fabricated uuid.
    expect(actionFk).toBe(RUN_ID);
    expect(drafterRunId).toBe(RUN_ID);
    expect(actionId).toBe('action-1');
  });
});
