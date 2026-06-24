import type Anthropic from '@anthropic-ai/sdk';
import { schema, type Database } from '@hale/db';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { askHale } from './agent';

/**
 * askHale orchestration mechanics with a FAKE Anthropic client (rule #8: the fake
 * drives the loop plumbing, never stands in for agent quality — that's an eval).
 *
 * We assert the multi-turn + persistence contract: a new conversation is opened,
 * the parent question and Hale's answer are both persisted as messages, and the
 * conversationId is returned so the next turn continues the same thread. The fake
 * db records inserts and serves the context reads; the fake client returns a
 * one-shot text answer (no tool calls), so the loop runs exactly one round-trip.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function textMessage(text: string): Anthropic.Message {
  return {
    id: 'msg-text',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    usage: usage(100, 30),
  };
}

function fakeClient(text: string): AgentClient {
  return {
    messages: { create: vi.fn(async () => textMessage(text)) },
  } as unknown as AgentClient;
}

interface InsertCapture {
  conversations: unknown[];
  messages: Array<{ conversationId: string; role: string; content: string }>;
  agentRuns: Record<string, unknown>[];
}

/**
 * A fake Database for the askHale flow. Inserts into conversations return a fixed
 * id; messages inserts are captured in order. Reads serve a minimal family with
 * no children / no memory, so the context assembles without touching real rows.
 * `existingConversationId` (when set) makes the conversation-resolve read return
 * that thread, so a "continue an existing thread" turn reuses it.
 */
function fakeDb(capture: InsertCapture, existingConversationId?: string): Database {
  const emptyChain = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), {
      limit: async () => rows.slice(0, 1),
      orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
    });

  const db = {
    insert: (table: unknown) => ({
      values: (rows: { conversationId?: string; role?: string; content?: string }) => {
        if (table === schema.conversations) {
          capture.conversations.push(rows);
          return { returning: async () => [{ id: CONVERSATION_ID }] };
        }
        if (table === schema.messages) {
          capture.messages.push({
            conversationId: rows.conversationId as string,
            role: rows.role as string,
            content: rows.content as string,
          });
          return Promise.resolve(undefined);
        }
        if (table === schema.auditLog) {
          return Promise.resolve(undefined);
        }
        if (table === schema.agentRuns) {
          capture.agentRuns.push(rows as Record<string, unknown>);
          return { returning: async () => [{ id: 'run-1' }] };
        }
        throw new Error('unexpected insert target');
      },
    }),
    select: (_cols?: unknown) => ({
      from: (table: unknown) => {
        // The families lookup returns one row; the conversation-resolve read
        // returns the existing thread when configured; everything else (members
        // join, children, facts, episodes, transcript) is empty.
        const rowsFor = (t: unknown): unknown[] => {
          if (t === schema.families) {
            return [{ planTier: 'free', city: null, province: null, country: null }];
          }
          if (t === schema.conversations && existingConversationId) {
            return [{ id: existingConversationId }];
          }
          return [];
        };
        const chain = {
          where: () => emptyChain(rowsFor(table)),
          innerJoin: () => chain,
          orderBy: () => emptyChain(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
  return db as unknown as Database;
}

describe('askHale — multi-turn persistence + conversationId', () => {
  it('opens a conversation, persists the question and answer, and returns the conversationId', async () => {
    const capture: InsertCapture = { conversations: [], messages: [], agentRuns: [] };
    const db = fakeDb(capture);

    const result = await askHale(
      {
        familyId: FAMILY_ID,
        question: 'when do I start solids?',
        intent: null,
        conversationId: null,
        focusedChildId: null,
        actor: 'user-1',
      },
      db,
      fakeClient('around six months is the common window — watch for readiness cues.'),
    );

    expect(result.conversationId).toBe(CONVERSATION_ID);
    expect(result.answer).toBe(
      'around six months is the common window — watch for readiness cues.',
    );

    // A fresh conversation was opened for the family.
    expect(capture.conversations).toEqual([{ familyId: FAMILY_ID }]);

    // Both turns persisted, in order, against the returned conversation.
    expect(capture.messages).toEqual([
      { conversationId: CONVERSATION_ID, role: 'user', content: 'when do I start solids?' },
      {
        conversationId: CONVERSATION_ID,
        role: 'assistant',
        content: 'around six months is the common window — watch for readiness cues.',
      },
    ]);

    // Metrics reflect the single round-trip (Sonnet, converse task).
    expect(result.metrics.promptTokens).toBe(100);
    expect(result.metrics.completionTokens).toBe(30);
    expect(result.metrics.modelUsed).toBe('claude-sonnet-4-6');

    // Exactly one agent_runs row, family-scoped, with real model + token counts +
    // latency, marked completed (observability gap closed).
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('ask-hale');
    expect(run.modelUsed).toBe('claude-sonnet-4-6');
    expect(run.promptTokens).toBe(100);
    expect(run.completionTokens).toBe(30);
    expect(typeof run.latencyMs).toBe('number');
    expect(run.status).toBe('completed');
  });

  it('records a FAILED agent_runs row and rethrows when the agent returns no answer (rule #8)', async () => {
    const capture: InsertCapture = { conversations: [], messages: [], agentRuns: [] };
    const db = fakeDb(capture);
    // A client that emits a tool_use the loop can't satisfy would loop to maxSteps;
    // simpler: an assistant turn with no text and no tool_use yields answer:null.
    const noAnswerClient = {
      messages: {
        create: vi.fn(async () => ({
          ...textMessage(''),
          content: [] as Anthropic.ContentBlock[],
        })),
      },
    } as unknown as AgentClient;

    await expect(
      askHale(
        {
          familyId: FAMILY_ID,
          question: 'anything?',
          intent: null,
          conversationId: null,
          focusedChildId: null,
          actor: 'user-1',
        },
        db,
        noAnswerClient,
      ),
    ).rejects.toThrow();

    // The failure was still recorded — one row, family-scoped, status 'failed'.
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('ask-hale');
    expect(run.status).toBe('failed');
    // No assistant message was persisted on the failure path.
    expect(capture.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('continues an existing thread when the conversation belongs to the family', async () => {
    const capture: InsertCapture = { conversations: [], messages: [], agentRuns: [] };
    // The conversation-resolve read returns the existing thread (it is owned by
    // this family), so askHale reuses it instead of opening a new one.
    const db = fakeDb(capture, CONVERSATION_ID);

    const result = await askHale(
      {
        familyId: FAMILY_ID,
        question: 'and what about allergens?',
        intent: null,
        conversationId: CONVERSATION_ID,
        focusedChildId: null,
        actor: 'user-1',
      },
      db,
      fakeClient('introduce common allergens early and one at a time.'),
    );

    expect(result.conversationId).toBe(CONVERSATION_ID);
    // No NEW conversation was created — the existing thread was reused.
    expect(capture.conversations).toEqual([]);
    expect(capture.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
