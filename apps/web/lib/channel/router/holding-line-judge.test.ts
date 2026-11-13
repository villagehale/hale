import { readFileSync } from 'node:fs';
import { type AgentClient, HAIKU_MODEL, JUDGE_MODEL, pickLane } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  HOLDING_LINE_JUDGE_TOOL,
  holdingLineJudgeUserMessage,
  judgeHoldingLine,
} from './holding-line-judge';

/**
 * Transport of the holding-line meaning gate (VIL-540). This client returns the
 * verdict the test hands it. It does not read meaning. Whether a line promises
 * a time or points at an app or a website is the cached judge eval
 * (run-holding-line-judge-eval.mjs). A miss sends nothing and supplies no copy.
 */

const CLEAR = "I'm on it. Your answer is coming.";

function clientReturning(text: string): AgentClient {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: 'end_turn',
        };
      },
    },
  } as unknown as AgentClient;
}

describe('judgeHoldingLine transport', () => {
  it('maps a clear verdict onto clear and returns no replacement text', async () => {
    const seen: { user?: string; required?: string[] }[] = [];
    const gate = await judgeHoldingLine(
      {
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
                  text: JSON.stringify({
                    reason: 'coming, with no when and no elsewhere',
                    promises_a_time: 'no',
                    points_at_an_app: 'no',
                  }),
                },
              ],
              usage: { input_tokens: 5, output_tokens: 5 },
              stop_reason: 'end_turn',
            };
          },
        },
      } as unknown as AgentClient,
      CLEAR,
    );
    expect(gate).toEqual({ verdict: 'clear' });
    expect(gate).not.toHaveProperty('line');
    expect(seen[0]?.user).toBe(holdingLineJudgeUserMessage(CLEAR));
    expect(seen[0]?.required).toEqual(['reason', 'promises_a_time', 'points_at_an_app']);
  });

  it('maps a time or a place onto refuse and returns no replacement text', async () => {
    const gate = await judgeHoldingLine(
      clientReturning(
        JSON.stringify({
          reason: 'it names a when',
          promises_a_time: 'yes',
          points_at_an_app: 'no',
        }),
      ),
      '我马上就回你。',
    );
    expect(gate).toEqual({ verdict: 'refuse', problems: ['promised_a_time'] });
    expect(gate).not.toHaveProperty('line');
  });

  it('names a judge that returns nothing usable', async () => {
    const gate = await judgeHoldingLine(
      clientReturning(
        JSON.stringify({ reason: '', promises_a_time: 'maybe', points_at_an_app: 'no' }),
      ),
      CLEAR,
    );
    expect(gate).toEqual({ verdict: 'unjudged', reason: 'judge_failed' });
    expect(gate).not.toHaveProperty('line');
  });

  it('loads a skill that judges and does not write the line', async () => {
    const skill = await loadCronSkill('holding-line-judge');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.name).toBe('holding-line-judge');
    expect(skill.meta.task).toBe('triage');
    expect(pickLane(skill.meta.task).model).toBe(HAIKU_MODEL);
    expect(pickLane(skill.meta.task).model).not.toBe(JUDGE_MODEL);
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('whatever language');
    expect(prose).toContain('do not rewrite');
    expect(prose).toContain('does not say when');
    expect(prose).not.toContain('>');
    expect(prose).not.toContain('{{include');
    expect(prose).not.toMatch(/"[^"]{8,}"/);
    expect(prose).not.toMatch(/\w+\|\w+/);
    expect(prose).not.toMatch(/\bthe app\b/i);
    expect(prose).not.toMatch(/\bthe website\b/i);
    for (const word of [
      'shortly',
      'momentarily',
      'jiffy',
      'dashboard',
      'villagehale',
      'bientôt',
      '马上',
    ]) {
      expect(prose.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(HOLDING_LINE_JUDGE_TOOL).toBe('holding_line_judge');
  });
});

describe('the judge module does not search the line', () => {
  it('has no word match and no example phrase', () => {
    const src = readFileSync(new URL('./holding-line-judge.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.includes\(/);
    expect(src).not.toMatch(/\.test\(/);
    expect(src).not.toMatch(/\w+\|\w+/);
    expect(src).not.toMatch(/\b(shortly|momentarily|jiffy|dashboard|villagehale)\b/i);
    expect(src).not.toMatch(/\bthe app\b/i);
    expect(src).not.toMatch(/\bthe website\b/i);
  });
});
