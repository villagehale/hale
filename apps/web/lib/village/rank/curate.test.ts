import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { curateShortlist, reconcilePicks } from './curate';

/**
 * Curate-path mechanics with a FAKE Anthropic client (rule #8). Curation differs
 * from ranking: it is allowed to DROP candidates (a shortlist is the few most
 * worth sharing), so we assert the agent's chosen SUBSET is honoured while
 * membership is enforced (no hallucinated pick, real ids only).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('reconcilePicks — agent curates, code enforces membership', () => {
  it('keeps the model-chosen subset in order (curation drops the rest)', () => {
    expect(reconcilePicks([C, A], [A, B, C])).toEqual([C, A]);
  });

  it('drops a hallucinated pick that is not a real candidate', () => {
    const fake = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(reconcilePicks([fake, B], [A, B])).toEqual([B]);
  });

  it('de-duplicates a repeated pick', () => {
    expect(reconcilePicks([A, A], [A, B])).toEqual([A]);
  });

  it('returns [] when the model picked nothing real', () => {
    expect(reconcilePicks([], [A, B])).toEqual([]);
  });
});

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function fakeDb(capture: { agentRuns: Record<string, unknown>[] }) {
  const build = (rows: unknown[]) => {
    const chain = {
      where: () => ({
        limit: async () => rows.slice(0, 1),
        orderBy: () => ({ limit: async () => rows }),
        groupBy: async () => rows,
      }),
      innerJoin: () => chain,
    };
    return Object.assign(Promise.resolve(rows), chain);
  };
  const db = {
    insert: (table: unknown) => ({
      values: (rows: Record<string, unknown>) => {
        if (table === schema.auditLog) return Promise.resolve(undefined);
        if (table === schema.agentRuns) {
          capture.agentRuns.push(rows);
          return { returning: async () => [{ id: 'run-1' }] };
        }
        throw new Error('unexpected insert target');
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.families) return build([{ areaCoarse: 'M5V', intents: [] }]);
        if (table === schema.villageEndorsements) return build([]);
        return build([]);
      },
    }),
  };
  return db as unknown as import('@hale/db').Database;
}

/** A fake client that answers with the chosen pick ids (no tool calls — the loop
 * runs one round-trip). Drives the harness; never stands in for curation quality. */
function pickClient(picks: string[]): AgentClient {
  const create = vi.fn(
    async () =>
      ({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(picks), citations: null }],
        usage: usage(80, 20),
      }) as unknown as Anthropic.Message,
  );
  return { messages: { create } } as unknown as AgentClient;
}

describe('curateShortlist — assembles the family picks', () => {
  it('returns the agent-curated subset and records an agent_runs row', async () => {
    const candidateIds = [A, B, C];
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const db = fakeDb(capture);
    // The agent picks the two most-worth-sharing — a true subset, not the whole set.
    const result = await curateShortlist(
      { familyId: FAMILY_ID, candidateIds, actor: 'user-1' },
      db,
      pickClient([B, C]),
    );

    expect(result.pickIds).toEqual([B, C]);
    expect(result.pickIds).not.toContain(A);

    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.agentName).toBe('curate-shortlist');
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.status).toBe('completed');
  });

  it('short-circuits with no model call for an empty candidate set (no spend)', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const client = pickClient([]);
    const result = await curateShortlist(
      { familyId: FAMILY_ID, candidateIds: [], actor: 'user-1' },
      fakeDb(capture),
      client,
    );
    expect(result.pickIds).toEqual([]);
    expect(client.messages.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
