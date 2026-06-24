import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { parseOrderedIds, rankRecommendations, reconcileOrder } from './rank';

/**
 * Ranking-path mechanics with a FAKE Anthropic client (rule #8: the fake drives
 * the harness loop, it never stands in for ranking QUALITY — that is an eval).
 *
 * What we assert is the orchestration contract the moat depends on:
 *  - the model's chosen order is honoured (the agent decides, not a hardcoded sort);
 *  - integrity is enforced — a hallucinated id can't enter and a forgotten id can't
 *    vanish (reconcileOrder), so the feed is always a clean permutation;
 *  - the three signals reach the model (the guarded tools are called);
 *  - an agent_runs row is recorded for cost observability.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('parseOrderedIds', () => {
  it('extracts a JSON array of ids from the model answer', () => {
    expect(parseOrderedIds(`Here is the order: ["${B}", "${A}", "${C}"]`)).toEqual([B, A, C]);
  });

  it('returns [] for a null or array-free answer', () => {
    expect(parseOrderedIds(null)).toEqual([]);
    expect(parseOrderedIds('no array here')).toEqual([]);
  });

  it('drops non-string array members', () => {
    expect(parseOrderedIds(`["${A}", 7, null, "${B}"]`)).toEqual([A, B]);
  });
});

describe('reconcileOrder — agent decides order, code enforces integrity', () => {
  it('honours the model order when it is a clean permutation', () => {
    expect(reconcileOrder([C, A, B], [A, B, C])).toEqual([C, A, B]);
  });

  it('drops a hallucinated id the model invented (it is not a real candidate)', () => {
    const hallucinated = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(reconcileOrder([hallucinated, B, A], [A, B])).toEqual([B, A]);
  });

  it('appends a candidate the model forgot, in its original order (never drops a real card)', () => {
    expect(reconcileOrder([C], [A, B, C])).toEqual([C, A, B]);
  });

  it('de-duplicates a repeated id', () => {
    expect(reconcileOrder([A, A, B], [A, B])).toEqual([A, B]);
  });

  it('falls back to the discovery order when the model gave nothing', () => {
    expect(reconcileOrder([], [A, B, C])).toEqual([A, B, C]);
  });
});

interface ToolReplies {
  fitContext: { childStages: string[]; intents: string[]; areaCoarse: string | null };
  tastes: Array<{ factType: string; factKey: string; factValue: unknown; confidence: number }>;
  endorsements: Map<string, number>;
}

/**
 * A fake db that serves the rank tools' reads and captures the agent_runs insert.
 * Routes each select by the table identity the rank tools query.
 */
function fakeDb(replies: ToolReplies, capture: { agentRuns: Record<string, unknown>[] }) {
  const childRows = replies.fitContext.childStages; // not used directly; tools derive stages
  void childRows;
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
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const build = (rows: unknown[]) => {
          const chain = {
            where: () => ({
              limit: async () => rows.slice(0, 1),
              orderBy: () => ({ limit: async () => rows }),
              groupBy: async () => rows,
            }),
            innerJoin: () => chain,
          };
          // listFamilyEndorsedCandidateIds + endorsement counts use .where() returning a promise
          return Object.assign(Promise.resolve(rows), chain);
        };

        if (table === schema.families) {
          return build([
            { areaCoarse: replies.fitContext.areaCoarse, intents: replies.fitContext.intents },
          ]);
        }
        if (table === schema.children) {
          // Empty: stages are exercised via the fit reply; teen filter sees no teens.
          return build([]);
        }
        if (table === schema.familyMemoryFacts) {
          return build(
            replies.tastes.map((t) => ({ childId: null, ...t })),
          );
        }
        if (table === schema.villageCandidates) {
          return build([]);
        }
        if (table === schema.villageEndorsements) {
          // countEndorsementsForCandidates: groupBy → [{ candidateId, value }]
          const rows = [...replies.endorsements].map(([candidateId, value]) => ({
            candidateId,
            value,
          }));
          return build(rows);
        }
        void cols;
        return build([]);
      },
    }),
  };
  return db as unknown as import('@hale/db').Database;
}

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

/**
 * A fake client that first CALLS the four signal tools (so we prove the signals
 * reach the agent), then on the next turn emits the ranked order as its answer.
 * The order it picks is the trust-then-fit order the signals imply, demonstrating
 * the agent — not a hardcoded sort — produced it.
 */
function signalThenRankClient(order: string[], candidateIds: string[]): AgentClient {
  let turn = 0;
  const create = vi.fn(async () => {
    turn += 1;
    if (turn === 1) {
      return {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [
          { type: 'tool_use', id: 't1', name: 'list_village_candidates', input: {} },
          { type: 'tool_use', id: 't2', name: 'get_family_fit_context', input: {} },
          { type: 'tool_use', id: 't3', name: 'get_family_tastes', input: {} },
          {
            type: 'tool_use',
            id: 't4',
            name: 'get_endorsement_signals',
            input: { candidateIds },
          },
        ],
        usage: usage(120, 40),
      } as unknown as Anthropic.Message;
    }
    return {
      id: 'm2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(order), citations: null }],
      usage: usage(60, 20),
    } as unknown as Anthropic.Message;
  });
  return { messages: { create } } as unknown as AgentClient;
}

describe('rankRecommendations — agent-driven order, signals reach the model', () => {
  it('returns the model-decided order and records an agent_runs row', async () => {
    const candidateIds = [A, B, C];
    // Trust signal: B and C endorsed, A not. Fit/taste favour the lively ones.
    const replies: ToolReplies = {
      fitContext: { childStages: ['toddler'], intents: ['stay_active'], areaCoarse: 'M5V' },
      tastes: [{ factType: 'preference', factKey: 'likes', factValue: 'outdoors', confidence: 1 }],
      endorsements: new Map([
        [B, 4],
        [C, 2],
      ]),
    };
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const db = fakeDb(replies, capture);
    // The agent ranks the trusted-and-fitting first: B (4 endorsements), C (2), A (0).
    const modelOrder = [B, C, A];
    const client = signalThenRankClient(modelOrder, candidateIds);

    const result = await rankRecommendations(
      { familyId: FAMILY_ID, candidateIds, actor: 'system' },
      db,
      client,
    );

    // The agent's order is honoured (not the input/discovery order A,B,C).
    expect(result.orderedIds).toEqual([B, C, A]);

    // Exactly one agent_runs row, family-scoped, agent named, completed.
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('rank-recommendations');
    expect(run.status).toBe('completed');
  });

  it('short-circuits with no model call for an empty candidate set (no spend)', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const client = signalThenRankClient([], []);
    const db = fakeDb(
      {
        fitContext: { childStages: [], intents: [], areaCoarse: null },
        tastes: [],
        endorsements: new Map(),
      },
      capture,
    );

    const result = await rankRecommendations(
      { familyId: FAMILY_ID, candidateIds: [], actor: 'system' },
      db,
      client,
    );

    expect(result.orderedIds).toEqual([]);
    expect((client.messages.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(capture.agentRuns).toHaveLength(0);
  });
});
