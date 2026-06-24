import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { runInferenceForFamily } from './inference';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-17T06:00:00Z');

interface Capture {
  auditLog: unknown[];
  factInserts: unknown[];
  factSupersedes: number;
  agentRuns: Record<string, unknown>[];
}

/**
 * Fakes the Drizzle chains runInferenceForFamily + its tools run. No real DB.
 *
 * Select order (read_recent_memory): events, episodes, facts — each
 * from().where()(.orderBy().limit())? → []. save_memory does an update (supersede)
 * then an insert(...).returning(). The audit insert routes by table identity.
 */
function fakeDb(capture: Capture) {
  let selectCall = 0;
  const select = vi.fn().mockImplementation(() => {
    const call = selectCall++;
    if (call === 0 || call === 1) {
      // events / episodes: from().where().orderBy().limit()
      return {
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
      };
    }
    // current facts: from().where()
    return { from: () => ({ where: async () => [] }) };
  });

  const update = vi.fn().mockImplementation(() => ({
    set: () => ({
      where: async () => {
        capture.factSupersedes += 1;
      },
    }),
  }));

  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.auditLog) {
      return {
        values: async (row: unknown) => {
          capture.auditLog.push(row);
        },
      };
    }
    if (table === schema.familyMemoryFacts) {
      return {
        values: (row: unknown) => ({
          returning: async () => {
            capture.factInserts.push(row);
            return [{ id: 'fact-1' }];
          },
        }),
      };
    }
    if (table === schema.agentRuns) {
      return {
        values: (row: Record<string, unknown>) => ({
          returning: async () => {
            capture.agentRuns.push(row);
            return [{ id: 'run-1' }];
          },
        }),
      };
    }
    throw new Error('unexpected insert target');
  });

  return { select, update, insert } as never;
}

/** A fake client that emits ONE save_memory tool call with the given confidence,
 * then a final summary. Exercises the harness + guarded write mechanics, not LLM
 * quality (rule #8). */
function fakeClient(confidence: number): AgentClient {
  let turn = 0;
  const create = vi.fn().mockImplementation(async () => {
    turn += 1;
    if (turn === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 's1',
            name: 'save_memory',
            input: {
              factType: 'routine',
              factKey: 'bedtime',
              factValue: { time: '19:30' },
              confidence,
            },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }
    return {
      content: [{ type: 'text', text: 'saved one routine fact.' }],
      usage: { input_tokens: 6, output_tokens: 4 },
    };
  });
  return { messages: { create } } as unknown as AgentClient;
}

describe('runInferenceForFamily', () => {
  it('saves a high-confidence inferred fact through the guarded tool and audits it (rule #6)', async () => {
    const capture: Capture = { auditLog: [], factInserts: [], factSupersedes: 0, agentRuns: [] };
    const db = fakeDb(capture);

    await runInferenceForFamily(FAMILY_ID, db, { client: fakeClient(0.9) }, NOW);

    // The fact was written, family-scoped, attributed to the inferencer.
    expect(capture.factInserts).toEqual([
      expect.objectContaining({
        familyId: FAMILY_ID,
        factType: 'routine',
        factKey: 'bedtime',
        confidence: 0.9,
        inferredBy: 'memory_inferencer',
      }),
    ]);

    // Rule #6: the guarded invoker wrote one audit row, actor 'system'.
    expect(capture.auditLog).toEqual([
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: 'system',
        actionTaken: 'tool:save_memory',
      }),
    ]);

    // Exactly one agent_runs row, family-scoped, real model + summed token counts
    // + latency, marked completed (observability gap closed).
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('infer-memory');
    expect(run.modelUsed).toBe('claude-sonnet-4-6');
    expect(run.promptTokens).toBe(16);
    expect(run.completionTokens).toBe(9);
    expect(typeof run.latencyMs).toBe('number');
    expect(run.status).toBe('completed');
  });

  it('records a FAILED agent_runs row and rethrows when the harness call throws (rule #8)', async () => {
    const capture: Capture = {
      auditLog: [],
      factInserts: [],
      factSupersedes: 0,
      agentRuns: [],
    };
    const db = fakeDb(capture);
    const boom = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('anthropic 529 overloaded');
        }),
      },
    } as unknown as AgentClient;

    await expect(
      runInferenceForFamily(FAMILY_ID, db, { client: boom }, NOW),
    ).rejects.toThrow('anthropic 529 overloaded');

    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('infer-memory');
    expect(run.status).toBe('failed');
    // No fact was written on the failure path.
    expect(capture.factInserts).toEqual([]);
  });

  it('REFUSES a below-0.7-confidence fact: no insert, but the call is still audited', async () => {
    const capture: Capture = { auditLog: [], factInserts: [], factSupersedes: 0, agentRuns: [] };
    const db = fakeDb(capture);

    await runInferenceForFamily(FAMILY_ID, db, { client: fakeClient(0.5) }, NOW);

    // The 0.7 floor is a code-level invariant: nothing is written below it.
    expect(capture.factInserts).toEqual([]);
    expect(capture.factSupersedes).toBe(0);
    // The tool call itself still ran through the guard, so it is audited.
    expect(capture.auditLog).toHaveLength(1);
  });
});
