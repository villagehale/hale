import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haru/db';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import { recordAction } from './memory-writer.js';

/**
 * FIX 2 — duplicate-action-on-classified-crash. Two assertions on the REAL
 * recordAction:
 *
 *  (a) Atomic fold: recordAction advances events.status to 'drafted' inside its
 *      own transaction, so a crash before any later checkpoint cannot leave the
 *      event at 'classified' with an action already written.
 *  (b) Idempotent insert: the actions insert uses onConflictDoNothing; when a
 *      prior pass already wrote the row (insert returns []), recordAction loads
 *      the existing action instead of minting a duplicate.
 */

const familyId = '11111111-1111-4111-8111-111111111111';
const eventId = '33333333-3333-4333-8333-333333333333';
const existingActionId = '22222222-2222-4222-8222-222222222222';

const drafterMetrics: AgentRunMetrics = {
  agentName: 'drafter',
  modelUsed: 'claude-sonnet-4-6',
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0.001,
  latencyMs: 200,
};

function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['set', 'where', 'from', 'values', 'onConflictDoNothing', 'returning', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

interface Stub {
  database: Database;
  updatedTables: () => string[];
  insertedTables: () => string[];
}

/**
 * actionsInsertRows controls what the actions insert .returning() resolves to:
 * a non-empty row = the insert won; [] = an onConflictDoNothing conflict (the
 * row already existed). existingActionRows is what the follow-up select resolves
 * to when recordAction has to load the pre-existing action.
 */
function stubDb(actionsInsertRows: unknown[], existingActionRows: unknown[] = []): Stub {
  const updatedTables: string[] = [];
  const insertedTables: string[] = [];
  let agentRunInserted = false;

  const tx = {
    insert: vi.fn((table: unknown) => {
      if (table === schema.auditLog) {
        insertedTables.push('audit_log');
        return builder([{ id: 'audit-1' }]);
      }
      if (table === schema.agentRuns) {
        agentRunInserted = true;
        insertedTables.push('agent_runs');
        return builder([{ id: 'run-1' }]);
      }
      if (table === schema.actions) {
        insertedTables.push('actions');
        return builder(actionsInsertRows);
      }
      insertedTables.push('other');
      return builder([{ id: 'x' }]);
    }),
    update: vi.fn((table: unknown) => {
      updatedTables.push(table === schema.events ? 'events' : 'other');
      return builder([]);
    }),
    select: vi.fn(() => builder(existingActionRows)),
  };
  void agentRunInserted;

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;

  return {
    database,
    updatedTables: () => updatedTables,
    insertedTables: () => insertedTables,
  };
}

const input = {
  familyId,
  eventId,
  actionType: 'send_email' as const,
  payload: { to: 'a@b.com', subject: 'hi', body: 'x' },
  drafterMetrics,
};

describe('recordAction — FIX 2 atomic drafted-fold + idempotency', () => {
  it('advances the event to drafted inside the same transaction (atomic fold)', async () => {
    const s = stubDb([{ id: existingActionId }]);
    await recordAction(input, s.database);

    expect((s.database.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // The event-status advance must be one of the writes in recordAction's tx.
    expect(s.updatedTables()).toContain('events');
  });

  it('loads the existing action (no duplicate) when the insert conflicts', async () => {
    const s = stubDb([], [{ id: existingActionId }]);
    const result = await recordAction(input, s.database);

    expect(result.actionId).toBe(existingActionId);
  });
});
