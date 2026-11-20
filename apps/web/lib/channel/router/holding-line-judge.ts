import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-540. Whether a holding line promises when the answer will arrive, or
 * points the parent at an app or a website, in whatever language it is written.
 * `refuse` means the line does not go out. The judge does not rewrite it and
 * does not supply a replacement. `unjudged` is the same outcome under a named
 * fault (rule #11): the check did not return a verdict, so nothing is sent.
 *
 * Design tip: the lane is the skill's `triage` (Haiku), not `JUDGE_MODEL`.
 * Whether a line actually promises a time or points elsewhere is the cached
 * holding-line judge eval, not a scripted verdict.
 */
export type HoldingLineJudge =
  | { verdict: 'clear' }
  | { verdict: 'refuse'; problems: HoldingLineMeaningProblem[] }
  | { verdict: 'unjudged'; reason: 'skill_unavailable' | 'judge_failed' };

/** The two meanings the English patterns used to guess at. */
export type HoldingLineMeaningProblem = 'promised_a_time' | 'points_at_the_app';

export const HOLDING_LINE_JUDGE_TOOL = 'holding_line_judge';
export const HOLDING_LINE_JUDGE_DESCRIPTION =
  'Decide whether this line promises a time or points at an app or a website. Do not rewrite it.';
export const HOLDING_LINE_JUDGE_MAX_TOKENS = 256;

export const HOLDING_LINE_JUDGE_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    promises_a_time: {
      type: 'string',
      enum: ['yes', 'no'],
      description:
        'yes when the line says when the answer arrives or that it arrives after a wait.',
    },
    points_at_an_app: {
      type: 'string',
      enum: ['yes', 'no'],
      description: 'yes when the line sends the parent to an app, a website, or another screen.',
    },
  },
  required: ['reason', 'promises_a_time', 'points_at_an_app'],
  additionalProperties: false,
};

const verdictSchema = z.object({
  reason: z.string(),
  promises_a_time: z.enum(['yes', 'no']),
  points_at_an_app: z.enum(['yes', 'no']),
});

/** The judge's user turn. Shared with the eval, which replays this request. */
export function holdingLineJudgeUserMessage(line: string): string {
  return JSON.stringify({ line });
}

/**
 * The request the judge sends. Loading it does not call a model. The eval's
 * dry run prices this shape; a live run replays it.
 */
export async function holdingLineJudgeRequest(line: string) {
  const skill = await loadCronSkill('holding-line-judge');
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: holdingLineJudgeUserMessage(line),
    toolName: HOLDING_LINE_JUDGE_TOOL,
    toolDescription: HOLDING_LINE_JUDGE_DESCRIPTION,
    toolSchema: HOLDING_LINE_JUDGE_SCHEMA,
    maxTokens: HOLDING_LINE_JUDGE_MAX_TOKENS,
  };
}

function problemsOf(value: z.infer<typeof verdictSchema>): HoldingLineMeaningProblem[] {
  const problems: HoldingLineMeaningProblem[] = [];
  if (value.promises_a_time === 'yes') problems.push('promised_a_time');
  if (value.points_at_an_app === 'yes') problems.push('points_at_the_app');
  return problems;
}

/**
 * Hard gate for one holding line. A dry client proves the request. Whether a
 * real model reads the meaning is a cached eval, not a live spend from this
 * process. A missing verdict sends nothing: this function never returns text.
 */
export async function judgeHoldingLine(
  client: AgentClient,
  line: string,
): Promise<HoldingLineJudge> {
  let request: Awaited<ReturnType<typeof holdingLineJudgeRequest>>;
  try {
    request = await holdingLineJudgeRequest(line);
  } catch {
    return { verdict: 'unjudged', reason: 'skill_unavailable' };
  }

  try {
    const { value } = await forceToolJson({
      client,
      lane: request.lane,
      system: request.system,
      userMessage: request.userMessage,
      toolName: request.toolName,
      toolDescription: request.toolDescription,
      inputJsonSchema: request.toolSchema,
      schema: verdictSchema,
      maxTokens: request.maxTokens,
    });
    const problems = problemsOf(value);
    return problems.length === 0 ? { verdict: 'clear' } : { verdict: 'refuse', problems };
  } catch {
    return { verdict: 'unjudged', reason: 'judge_failed' };
  }
}
