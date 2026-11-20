import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { loadReplyCopySkill } from '~/lib/cron/skill';
import { replyProse } from './apply';

/**
 * Injected model. A clean answer sends. A failed check or a thrown call holds
 * the send. The locked sentence does not go out.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const SKILL: Skill = {
  meta: { name: 'reply-copy', whenToUse: 'test', task: 'draft', tools: [] },
  instructions: 'write the reply from the facts',
};

const LOCKED_ASK = "Nobody has Theo's swim, Saturday at 9 yet. Who's taking it?";
const MODEL_ASK = "Nobody has Theo's swim on Saturday at 9 yet. Who's taking it?";
const FACTS = ['Theo', 'swim', 'Saturday', '9'];

function fakeDb(capture: { audits: Record<string, unknown>[]; runs: Record<string, unknown>[] }) {
  return {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === schema.auditLog) capture.audits.push(row);
        if (table === schema.agentRuns) capture.runs.push(row);
        return { returning: () => Promise.resolve([{ id: 'run-1' }]) };
      },
    }),
  } as never;
}

function fakeClient(text: string | { throws: true }): AgentClient & {
  messages: { create: ReturnType<typeof vi.fn> };
} {
  return {
    messages: {
      create: vi.fn(async () => {
        if (typeof text !== 'string') throw new Error('model unavailable');
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 12, output_tokens: 8 },
          stop_reason: 'end_turn',
        } as unknown as Anthropic.Message;
      }),
    },
  } as unknown as AgentClient & { messages: { create: ReturnType<typeof vi.fn> } };
}

function deps(client: AgentClient | null, database: ReturnType<typeof fakeDb>) {
  return {
    client,
    database,
    familyId: FAMILY_ID,
    language: 'en' as const,
    audience: 'group' as const,
    surface: 'duty' as const,
    skill: SKILL,
  };
}

describe('reply prose fallback', () => {
  it('sends the model sentence when every check passes', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(JSON.stringify({ text: MODEL_ASK }));
    const text = await replyProse(deps(client, fakeDb(capture)), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBe(MODEL_ASK);
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_composed');
    expect(capture.runs[0]?.status).toBe('completed');
    expect(capture.runs[0]?.agentName).toBe('reply-copy');
  });

  it('holds the send when a check fails', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(
      JSON.stringify({
        text: "Nobody has Theo's swim booked on Saturday at 9 yet. Who's taking it?",
      }),
    );
    const text = await replyProse(deps(client, fakeDb(capture)), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBeNull();
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_fallback');
    expect(capture.runs[0]?.status).toBe('failed');
  });

  it('holds the send when the model call throws', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const text = await replyProse(deps(fakeClient({ throws: true }), fakeDb(capture)), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBeNull();
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_fallback');
    expect(capture.runs).toHaveLength(0);
  });

  it('does not call the model when no client is configured', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const text = await replyProse(deps(null, fakeDb(capture)), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBeNull();
    expect(capture.audits).toHaveLength(0);
  });
});

describe('a memory reply written by a named skill', () => {
  it('loads that skill by name, raises the output budget, and sends only the model text', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const list = '- swimming: saturday class, you told me\n- district: midtown, from your calendar';
    const client = fakeClient(JSON.stringify({ text: list }));
    const text = await replyProse(
      {
        ...deps(client, fakeDb(capture)),
        skill: undefined,
        skillName: 'memory-reply',
        audience: 'direct',
        surface: 'memory',
      },
      {
        purpose: 'memory_list',
        facts: [
          'swimming: saturday class (source: the parent told Hale)',
          'district: midtown (source: their calendar)',
        ],
        maxTokens: 1600,
      },
    );
    expect(text).toBe(list);
    const request = client.messages.create.mock.calls[0]?.[0] as {
      max_tokens: number;
      system: unknown;
    };
    expect(request.max_tokens).toBe(1600);
    expect(JSON.stringify(request.system)).toContain('What Hale remembers');
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_composed');
  });

  it('clamps an output budget past the ceiling', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(JSON.stringify({ text: 'Nothing saved yet.' }));
    await replyProse(
      { ...deps(client, fakeDb(capture)), audience: 'direct', surface: 'memory' },
      { facts: [], maxTokens: 50_000 },
    );
    const request = client.messages.create.mock.calls[0]?.[0] as { max_tokens: number };
    expect(request.max_tokens).toBe(2048);
  });
});

describe('reply-copy skill', () => {
  it('loads the skill by name', async () => {
    const skill = await loadReplyCopySkill();
    expect(skill.meta.name).toBe('reply-copy');
    expect(skill.meta.task).toBe('draft');
    expect(skill.instructions.length).toBeGreaterThan(40);
  });
});
