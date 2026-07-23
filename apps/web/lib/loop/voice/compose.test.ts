import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { composeVoice, firstJsonObject } from './compose';

/**
 * composeVoice MECHANICS with a FAKE Anthropic client (rule #8: the fake drives the
 * seam + the fallback paths, never the voice QUALITY — that is the cached-real eval in
 * apps/worker/evals). We assert the contract every voiced template depends on: a clean
 * answer becomes a typed voice; a broken answer, an INVENTED FACT, or a thrown call all
 * degrade to `{ voice: null, degraded: true }` (never throwing); and an agent_runs row
 * is recorded with the right status.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

const SKILL: Skill = {
  meta: { name: 'test-voice', whenToUse: 'test', task: 'draft', tools: [] },
  instructions: 'compose the voice',
};

type TestVoice = { line: string };

function parse(answer: string | null): TestVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { line?: unknown };
    return typeof value.line === 'string' ? { line: value.line } : null;
  } catch {
    return null;
  }
}

/** A fake db that captures the recordAgentRun insert and returns an id. */
function fakeDb(capture: { agentRuns: Record<string, unknown>[] }) {
  return {
    insert: (table: unknown) => ({
      values: (rows: Record<string, unknown>) => {
        if (table === schema.agentRuns) {
          capture.agentRuns.push(rows);
          return { returning: () => Promise.resolve([{ id: 'run-1' }]) };
        }
        return { returning: () => Promise.resolve([{ id: 'x' }]) };
      },
    }),
  } as never;
}

/** A fake client whose single create call returns `text`, or throws when `throws`. */
function fakeClient(text: string | { throws: true }): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => {
        if (typeof text !== 'string') throw new Error('model unavailable');
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 100, output_tokens: 20 },
        } as unknown as Anthropic.Message;
      }),
    },
  } as unknown as AgentClient;
}

function run(text: string | { throws: true }, factSlots: string[], capture: { agentRuns: Record<string, unknown>[] }) {
  return composeVoice<TestVoice>({
    skill: SKILL,
    context: { hi: true },
    factSlots,
    parse,
    voiceStrings: (v) => [v.line],
    client: fakeClient(text),
    database: fakeDb(capture),
    familyId: FAMILY_ID,
    agentName: 'weekly-plan-voice',
    traceName: 'weekly-plan-voice',
    maxTokens: 256,
  });
}

describe('composeVoice', () => {
  it('turns a clean JSON answer into a typed voice and records a completed run', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { voice, degraded } = await run(JSON.stringify({ line: 'a calm week ahead' }), [], capture);
    expect(degraded).toBe(false);
    expect(voice).toEqual({ line: 'a calm week ahead' });
    expect(capture.agentRuns).toHaveLength(1);
    expect(capture.agentRuns[0]?.status).toBe('completed');
  });

  it('degrades (null, flagged, recorded failed) when the answer carries no usable JSON', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { voice, degraded } = await run('I cannot help with that.', [], capture);
    expect(voice).toBeNull();
    expect(degraded).toBe(true);
    expect(capture.agentRuns[0]?.status).toBe('failed');
  });

  it('degrades when a voice string invents a fact (a time) not in the slots (rule #8)', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { voice, degraded } = await run(JSON.stringify({ line: 'see you at 9:15 sharp' }), ['no times here'], capture);
    expect(voice).toBeNull();
    expect(degraded).toBe(true);
    expect(capture.agentRuns[0]?.status).toBe('failed');
  });

  it('keeps a voice whose facts are all grounded in the slots', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { voice, degraded } = await run(JSON.stringify({ line: 'drop-off is at 9:15' }), ['school run 9:15'], capture);
    expect(degraded).toBe(false);
    expect(voice).toEqual({ line: 'drop-off is at 9:15' });
  });

  it('degrades to null when the model call throws, never surfacing the error (rule #8)', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { voice, degraded } = await run({ throws: true }, [], capture);
    expect(voice).toBeNull();
    expect(degraded).toBe(true);
  });
});
