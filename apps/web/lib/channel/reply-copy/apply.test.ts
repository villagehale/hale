import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { loadReplyCopySkill } from '~/lib/cron/skill';
import { memoryRecallParts, paginateMemoryRecall } from '~/lib/memory/kinds';
import { replyFrame, replyProse } from './apply';

/**
 * Injected model. A clean answer sends. A failed check, a thrown call, or the
 * flag being off sends the locked string and does not invent a second send.
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

function deps(client: AgentClient | null, database: ReturnType<typeof fakeDb>, flagOn = true) {
  return {
    client,
    database,
    familyId: FAMILY_ID,
    language: 'en' as const,
    audience: 'group' as const,
    flagOn,
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

  it('sends the locked string when a check fails', async () => {
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
    expect(text).toBe(LOCKED_ASK);
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_fallback');
    expect(capture.runs[0]?.status).toBe('failed');
  });

  it('sends the locked string when the model call throws', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const text = await replyProse(deps(fakeClient({ throws: true }), fakeDb(capture)), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBe(LOCKED_ASK);
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_fallback');
    expect(capture.runs).toHaveLength(0);
  });

  it('does not call the model when the copy flag is off', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(JSON.stringify({ text: MODEL_ASK }));
    const text = await replyProse(deps(client, fakeDb(capture), false), {
      fallback: LOCKED_ASK,
      facts: FACTS,
    });
    expect(text).toBe(LOCKED_ASK);
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(capture.audits).toHaveLength(0);
  });
});

describe('reply frame', () => {
  const parts = memoryRecallParts('en', [
    { key: 'soccer', value: 'soccer', source: 'inferred', kind: 'one_off' },
  ]);
  const opening =
    "Here's what I have: Maya is 4, you're near L3R, and I think soccer is her thing for now.";
  const closing = 'Wrong or old? Say "correct" or "forget" and the key.';

  it('writes only the opening and closing around the locked list line', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(JSON.stringify({ opening, closing, lines: ['HACKED'] }));
    const frame = await replyFrame(
      {
        ...deps(client, fakeDb(capture)),
        audience: 'direct',
        surface: 'memory',
      },
      {
        header: parts.header,
        footer: parts.footer,
        facts: [...parts.lines, 'Maya', '4', 'L3R', 'soccer'],
      },
    );
    const body = paginateMemoryRecall(frame.header, parts.lines, frame.footer).join('\n');
    expect(frame.header).toBe(opening);
    expect(frame.footer).toBe(closing);
    expect(body).toContain(parts.lines[0]);
    expect(body).not.toContain('HACKED');
  });

  it('keeps the locked header and footer when the closing fails a check', async () => {
    const capture = {
      audits: [] as Record<string, unknown>[],
      runs: [] as Record<string, unknown>[],
    };
    const client = fakeClient(JSON.stringify({ opening, closing: 'You are booked.' }));
    const frame = await replyFrame(
      {
        ...deps(client, fakeDb(capture)),
        audience: 'direct',
        surface: 'memory',
      },
      {
        header: parts.header,
        footer: parts.footer,
        facts: [...parts.lines, 'Maya', '4', 'L3R', 'soccer'],
      },
    );
    expect(frame).toEqual({ header: parts.header, footer: parts.footer });
    expect(capture.audits[0]?.actionTaken).toBe('reply_copy_fallback');
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
