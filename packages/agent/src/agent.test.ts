import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AgentClient, runAgent } from './agent.js';
import type { Skill } from './skill.js';
import { type AuditEntry, type GuardDeps, defineTool } from './tool.js';

/**
 * A fake Anthropic client that replays a SCRIPT of messages. It exercises the
 * loop MECHANICS only (a tool call fed back, the maxSteps hard stop). Agent
 * QUALITY is evaluated against real cached Claude responses elsewhere (rule #8) —
 * this fake never stands in for the model's reasoning.
 */
function fakeClient(script: Anthropic.Message[]): AgentClient {
  let calls = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const msg = script[calls];
        calls += 1;
        if (!msg) {
          throw new Error('fakeClient: script exhausted');
        }
        return msg;
      }),
    },
  } as unknown as AgentClient;
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

function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
  u: Anthropic.Usage,
): Anthropic.Message {
  return {
    id: 'msg-tool',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock],
    usage: u,
  };
}

function textMessage(text: string, u: Anthropic.Usage): Anthropic.Message {
  return {
    id: 'msg-text',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    usage: u,
  };
}

const skill: Skill = {
  meta: {
    name: 'ask-hale',
    whenToUse: 'test',
    task: 'converse',
    tools: ['get_child_profile'],
  },
  instructions: 'You answer parenting questions.',
};

const profileTool = defineTool({
  name: 'get_child_profile',
  description: 'Read a child profile.',
  inputSchema: z.object({ childId: z.string() }),
  handler: async (input: { childId: string }) => ({ childId: input.childId, ageMonths: 5 }),
});

function guardDeps(): { deps: GuardDeps; audits: AuditEntry[] } {
  const audits: AuditEntry[] = [];
  return {
    audits,
    deps: {
      writeAudit: async (entry) => {
        audits.push(entry);
      },
    },
  };
}

describe('runAgent loop mechanics', () => {
  it('dispatches a tool call, feeds the result back, then returns the final answer', async () => {
    const client = fakeClient([
      toolUseMessage('tu-1', 'get_child_profile', { childId: 'kid-1' }, usage(100, 20)),
      textMessage('your 5-month-old is right on track.', usage(120, 30)),
    ]);
    const { deps, audits } = guardDeps();

    const result = await runAgent({
      skill,
      context: { question: 'is my baby on track?' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    expect(result.answer).toBe('your 5-month-old is right on track.');
    expect(result.steps).toBe(2);
    expect(result.hitMaxSteps).toBe(false);
    // Usage is summed across both round-trips.
    expect(result.usage).toEqual({ promptTokens: 220, completionTokens: 50 });
    // The tool went through the guarded invoker → an audit row was written (rule #6).
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool:get_child_profile',
        after: { childId: 'kid-1' },
      },
    ]);
  });

  it('hard-stops at maxSteps when the model keeps calling tools', async () => {
    const client = fakeClient([
      toolUseMessage('a', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      toolUseMessage('b', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      toolUseMessage('c', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      textMessage('done', usage(10, 5)),
    ]);
    const { deps } = guardDeps();

    const result = await runAgent({
      skill,
      context: {},
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    expect(result.hitMaxSteps).toBe(true);
    expect(result.answer).toBeNull();
    expect(result.steps).toBe(2);
  });

  it('feeds a bad-argument tool error back to the model instead of crashing the turn', async () => {
    // Regression: the model invented an out-of-schema arg (childId must be a string).
    // invokeTool's parse throws — the loop must return an is_error tool_result so the
    // model self-corrects, NOT propagate the throw and 500 the whole request.
    const client = fakeClient([
      toolUseMessage('tu-bad', 'get_child_profile', { childId: 42 }, usage(50, 10)),
      textMessage('here is general guidance.', usage(60, 15)),
    ]);
    const { deps, audits } = guardDeps();

    const result = await runAgent({
      skill,
      context: { question: 'help' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    // The turn did NOT crash — the model got the error back and answered.
    expect(result.answer).toBe('here is general guidance.');
    expect(result.steps).toBe(2);
    expect(result.hitMaxSteps).toBe(false);
    // The rejected call's handler never ran, so nothing was audited (rule #6).
    expect(audits).toEqual([]);
  });

  it('refuses a tool the skill does not list, even if the model calls it', async () => {
    const client = fakeClient([
      toolUseMessage('x', 'place_supply_order', { item: 'wipes' }, usage(10, 5)),
    ]);
    const { deps } = guardDeps();
    const orderTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ item: z.string() }),
      handler: async () => ({ ok: true }),
    });

    await expect(
      runAgent({
        skill,
        context: {},
        tools: [profileTool, orderTool],
        client,
        maxSteps: 3,
        toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
        guardDeps: deps,
      }),
    ).rejects.toThrow(/not in skill 'ask-hale' allowlist/);
  });
});
