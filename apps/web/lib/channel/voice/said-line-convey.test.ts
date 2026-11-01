import { readFileSync } from 'node:fs';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { type SaidLineInput, acceptSaidLine, createSaidLineWriter } from './said-line';
import { judgeSaidLineConvey, saidLineConveyUserMessage } from './said-line-convey';

/**
 * Mechanics of the mustConvey gate (VIL-530). Whether a real model reads the
 * meaning is a cached eval. This client never leaves the process.
 */

/** The production pendingClosed fact. reply.test.ts pins this string to reply.ts. */
const PENDING = 'any introductions that were waiting for them are closed';

const off: SaidLineInput = {
  purpose: 'intro_reply',
  language: null,
  parentWords: '紹介はもういらないです',
  facts: {
    situation: 'they just switched introductions off for themselves',
    pendingClosed: PENDING,
    standing: 'the parent has introductions switched off',
  },
  mustConvey: ['pendingClosed'],
};

function scriptedClient(decide: (user: string) => unknown) {
  const seen: string[] = [];
  const client = {
    messages: {
      async create(req: { messages?: Array<{ content?: string }> }) {
        const user = req.messages?.[0]?.content ?? '';
        seen.push(user);
        return {
          content: [{ type: 'text', text: JSON.stringify(decide(user)) }],
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: 'end_turn',
        };
      },
    },
  } as unknown as AgentClient;
  return { client, seen };
}

function isJudgeTurn(user: string): boolean {
  return user.includes('"draft"');
}

describe('judgeSaidLineConvey', () => {
  it('sends when the judge says every meaning is carried, and does not rewrite', async () => {
    const draft = '紹介はオフにしました。待っていたものは、全部閉じました。';
    const seen: { user?: string; required?: string[] }[] = [];
    const gate = await judgeSaidLineConvey(
      () =>
        ({
          messages: {
            async create(req: {
              messages?: Array<{ content?: string }>;
              output_config?: { format?: { schema?: { required?: string[] } } };
            }) {
              seen.push({
                user: req.messages?.[0]?.content,
                required: req.output_config?.format?.schema?.required,
              });
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ reason: 'the waiting ones ended', conveyed: 'yes' }),
                  },
                ],
                usage: { input_tokens: 5, output_tokens: 5 },
                stop_reason: 'end_turn',
              };
            },
          },
        }) as unknown as AgentClient,
      draft,
      [{ key: 'pendingClosed', meaning: PENDING }],
    );
    expect(gate).toEqual({ verdict: 'send' });
    expect(seen[0]?.user).toBe(
      saidLineConveyUserMessage(draft, [{ key: 'pendingClosed', meaning: PENDING }]),
    );
    expect(seen[0]?.required).toEqual(['reason', 'conveyed']);
    expect(seen[0]?.user).not.toContain('わかりました');
  });

  it('omits when a required meaning is absent, with no replacement text', async () => {
    const gate = await judgeSaidLineConvey(
      () =>
        ({
          messages: {
            async create() {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ reason: 'only an acknowledgement', conveyed: 'no' }),
                  },
                ],
                usage: { input_tokens: 5, output_tokens: 5 },
                stop_reason: 'end_turn',
              };
            },
          },
        }) as unknown as AgentClient,
      'わかりました。',
      [{ key: 'pendingClosed', meaning: PENDING }],
    );
    expect(gate).toEqual({ verdict: 'omit' });
    expect(gate).not.toHaveProperty('text');
  });

  it('names a missing client and does not send', async () => {
    const gate = await judgeSaidLineConvey(
      () => {
        throw new Error('ANTHROPIC_API_KEY is not set');
      },
      'わかりました。',
      [{ key: 'pendingClosed', meaning: PENDING }],
    );
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'client_unavailable' });
  });

  it('names a judge that returns nothing usable', async () => {
    const gate = await judgeSaidLineConvey(
      () =>
        ({
          messages: {
            async create() {
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ reason: '', conveyed: 'maybe' }) },
                ],
                usage: { input_tokens: 5, output_tokens: 5 },
                stop_reason: 'end_turn',
              };
            },
          },
        }) as unknown as AgentClient,
      'わかりました。',
      [{ key: 'pendingClosed', meaning: PENDING }],
    );
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'judge_failed' });
  });

  it('loads a skill that judges and does not write the reply', async () => {
    const skill = await loadCronSkill('said-line-convey-judge');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('triage');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('do not rewrite');
    expect(prose).toContain('whatever language');
    expect(prose).not.toContain('pendingClosed');
    expect(prose).not.toContain(PENDING);
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
    expect(prose).not.toMatch(/\w+\|\w+/);
    expect(prose).not.toMatch(/\bclosed\b/i);
  });
});

describe('the convey module does not search the draft', () => {
  it('has no word match and no fact text', () => {
    const src = readFileSync(new URL('./said-line-convey.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.includes\(/);
    expect(src).not.toMatch(/\bclosed\b/i);
    expect(src).not.toContain(PENDING);
  });
});

describe('createSaidLineWriter · intro off (VIL-530)', () => {
  const conveys = '紹介はオフにしました。待っていたものは、全部閉じました。';
  const omits = 'わかりました。';

  it('sends the model text unchanged when the judge says the meaning is there', async () => {
    const { client, seen } = scriptedClient((user) =>
      isJudgeTurn(user) ? { reason: 'waiting ones ended', conveyed: 'yes' } : { text: conveys },
    );
    const sent = await createSaidLineWriter(client).write(off);
    expect(sent).toBe(conveys);
    expect(sent).not.toContain(PENDING);
    const judge = seen.find(isJudgeTurn);
    expect(judge).toBe(
      saidLineConveyUserMessage(conveys, [{ key: 'pendingClosed', meaning: PENDING }]),
    );
    expect(acceptSaidLine(omits, off)).toBe(omits);
  });

  it('sends nothing when the draft omits the meaning, and does not rewrite it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = scriptedClient((user) =>
      isJudgeTurn(user) ? { reason: 'acknowledgement only', conveyed: 'no' } : { text: omits },
    );
    const sent = await createSaidLineWriter(client).write(off);
    expect(sent).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'intro_reply', reason: 'must_convey' }),
      expect.any(String),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(omits);
    expect(JSON.stringify(error.mock.calls)).not.toContain(PENDING);
    error.mockRestore();
  });

  it('sends nothing when the judge does not run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const client = {
      messages: {
        async create() {
          calls += 1;
          if (calls > 1) throw new Error('down');
          return {
            content: [{ type: 'text', text: JSON.stringify({ text: conveys }) }],
            usage: { input_tokens: 5, output_tokens: 5 },
            stop_reason: 'end_turn',
          };
        },
      },
    } as unknown as AgentClient;
    const sent = await createSaidLineWriter(client).write(off);
    expect(sent).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'judge_failed' }),
      expect.any(String),
    );
    error.mockRestore();
  });

  it('does not call the judge when no meaning is required', async () => {
    const { client, seen } = scriptedClient(() => ({
      text: 'I can’t advise on that. Health811 is 811, and an emergency is 911.',
    }));
    const health: SaidLineInput = {
      purpose: 'health',
      language: 'en',
      parentWords: 'my son fell',
      facts: { healthLine: '811', emergency: '911' },
      mustInclude: ['811', '911'],
    };
    const sent = await createSaidLineWriter(client).write(health);
    expect(sent).toContain('811');
    expect(seen.some(isJudgeTurn)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('judges the outbound text, after a link slot is filled, and returns that text', async () => {
    const url = 'https://hale.example/connect?t=a';
    const input: SaidLineInput = {
      ...off,
      facts: { ...off.facts, link: '[[link]]' },
      links: { link: url },
    };
    const { client, seen } = scriptedClient((user) =>
      isJudgeTurn(user)
        ? { reason: 'waiting ones ended', conveyed: 'yes' }
        : { text: `${conveys}\n[[link]]` },
    );
    const sent = await createSaidLineWriter(client).write(input);
    const outbound = `${conveys}\n${url}`;
    expect(sent).toBe(outbound);
    expect(seen.find(isJudgeTurn)).toContain(url);
    expect(seen.find(isJudgeTurn)).not.toContain('[[link]]');
  });
});
