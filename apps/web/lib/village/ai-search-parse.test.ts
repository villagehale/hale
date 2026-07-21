import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { parseVillageSearchIntent } from './ai-search-parse';

/**
 * Intent-parse MECHANICS with a FAKE Anthropic client (rule #8: the fake drives the
 * harness loop + the fallback path, never the parse QUALITY — that is the cached-real
 * eval in apps/worker/evals). We assert the orchestration contract the search
 * depends on: a clean answer becomes a typed intent; a broken/failed model call
 * degrades to a keyword intent (visible, flagged, logged) rather than throwing; and
 * an agent_runs row is recorded either way.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

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
    // buildGuardDeps reads nothing at construction time in this path.
  } as never;
}

/** A fake client whose single create call returns the given text as the answer, or
 * throws when `throws` is set. */
function fakeClient(text: string | { throws: true }): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => {
        if (typeof text !== 'string') throw new Error('model unavailable');
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 120, output_tokens: 30 },
        } as unknown as Anthropic.Message;
      }),
    },
  } as unknown as AgentClient;
}

describe('parseVillageSearchIntent', () => {
  it('turns a clean JSON answer into a typed intent and records a completed run', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const answer = JSON.stringify({
      categories: ['childcare'],
      keywords: ['montessori'],
      season: 'fall',
      childAgeMonths: 40,
      familyScoped: false,
    });
    const { intent, degraded } = await parseVillageSearchIntent(
      { prompt: 'a good montessori start in fall', familyId: FAMILY_ID, childrenAgesMonths: [40], hasTeen: false, areaCoarse: 'M4K' },
      fakeDb(capture),
      fakeClient(answer),
    );
    expect(degraded).toBe(false);
    expect(intent.keywords).toEqual(['montessori']);
    expect(intent.season).toBe('fall');
    expect(intent.childAgeMonths).toBe(40);
    expect(capture.agentRuns).toHaveLength(1);
    expect(capture.agentRuns[0]?.status).toBe('completed');
  });

  it('degrades to a keyword intent (flagged, recorded failed) when the answer has no JSON', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { intent, degraded } = await parseVillageSearchIntent(
      { prompt: 'swim lessons this winter', familyId: FAMILY_ID, childrenAgesMonths: [], hasTeen: false, areaCoarse: null },
      fakeDb(capture),
      fakeClient('I cannot help with that.'),
    );
    expect(degraded).toBe(true);
    expect(intent.keywords).toContain('swim');
    expect(intent.season).toBe('winter');
    expect(capture.agentRuns[0]?.status).toBe('failed');
  });

  it('degrades to a keyword intent when the model call throws, never surfacing the error (rule #8)', async () => {
    const capture = { agentRuns: [] as Record<string, unknown>[] };
    const { intent, degraded } = await parseVillageSearchIntent(
      { prompt: 'french immersion preschool', familyId: FAMILY_ID, childrenAgesMonths: [], hasTeen: false, areaCoarse: null },
      fakeDb(capture),
      fakeClient({ throws: true }),
    );
    expect(degraded).toBe(true);
    expect(intent.keywords).toEqual(expect.arrayContaining(['french', 'immersion', 'preschool']));
  });

  it('sends only the coarse area + non-teen ages to the model, never a teen age (rule #1)', async () => {
    const client = fakeClient(JSON.stringify({ keywords: ['soccer'] }));
    await parseVillageSearchIntent(
      { prompt: 'soccer for my kids', familyId: FAMILY_ID, childrenAgesMonths: [40], hasTeen: true, areaCoarse: 'M4K' },
      fakeDb({ agentRuns: [] }),
      client,
    );
    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    // The context rides on both the system prompt and the first user turn (runAgent);
    // read the raw strings so we inspect the real serialized context, not re-escaped.
    const context = `${call.system}\n${JSON.stringify(call.messages)}`;
    expect(context).toContain('"ageMonths":40');
    expect(context).toContain('"hasTeen":true');
    // No teen age was ever provided to the parser, so none can appear in the request.
    expect(context).not.toMatch(/"ageMonths":\s*1[5-9]\d/);
  });
});
