import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { judgeWholeFindReply } from './find-reasoning-judge';

/**
 * Mechanics of the find-reasoning gate. Whether a real model withholds the right
 * drafts is a cached eval, not run here: this client never leaves the process.
 */

function dryClient(
  body: unknown,
  seen: { user?: string; system?: string; required?: string[] }[] = [],
) {
  return () =>
    ({
      messages: {
        async create(req: {
          system?: Array<{ text?: string }>;
          messages?: Array<{ content?: string }>;
          output_config?: { format?: { schema?: { required?: string[] } } };
        }) {
          seen.push({
            user: req.messages?.[0]?.content,
            system: (req.system ?? []).map((block) => block.text ?? '').join(''),
            required: req.output_config?.format?.schema?.required,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(body) }],
            usage: { input_tokens: 5, output_tokens: 5 },
            stop_reason: 'end_turn',
          };
        },
      },
    }) as unknown as AgentClient;
}

describe('judgeWholeFindReply', () => {
  it('withholds when the judge says the whole draft is reasoning', async () => {
    const seen: { user?: string; required?: string[] }[] = [];
    const gate = await judgeWholeFindReply(
      dryClient({ reason: 'only a comment on the set', withhold: 'yes' }, seen),
      'All three finds share one page…',
    );
    expect(gate).toEqual({ verdict: 'withhold' });
    expect(seen[0]?.user).toBe(JSON.stringify({ draft: 'All three finds share one page…' }));
    expect(seen[0]?.required).toEqual(['reason', 'withhold']);
  });

  it('sends when any of the draft is a find, and does not rewrite it', async () => {
    const draft = 'All three finds are at the library: Storytime Saturday at 10.';
    const gate = await judgeWholeFindReply(
      dryClient({ reason: 'a place and a time', withhold: 'no' }),
      draft,
    );
    expect(gate).toEqual({ verdict: 'send' });
  });

  it('names a missing client and does not send', async () => {
    const gate = await judgeWholeFindReply(() => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }, 'EarlyON Saturday at 10.');
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'client_unavailable' });
  });

  it('names a judge that returns nothing usable', async () => {
    const gate = await judgeWholeFindReply(
      dryClient({ reason: '', withhold: 'maybe' }),
      'EarlyON Saturday at 10.',
    );
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'judge_failed' });
  });

  it('loads a skill that judges and does not write the reply', async () => {
    const skill = await loadCronSkill('find-reasoning-judge');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('triage');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('do not rewrite');
    expect(prose).toContain('whatever language');
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
  });
});
