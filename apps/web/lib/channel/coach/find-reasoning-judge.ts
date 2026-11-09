import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * Whether a nearby-find draft may be sent. `withhold` means the whole reply is
 * the coach's own reasoning and the parent is sent nothing. The judge does not
 * rewrite. `unjudged` is the same outcome under a named fault (rule #11): the
 * hard gate did not run, so the draft does not go out.
 */
export type FindReplyGate =
  | { verdict: 'send' }
  | { verdict: 'withhold' }
  | {
      verdict: 'unjudged';
      reason: 'client_unavailable' | 'skill_unavailable' | 'judge_failed';
    };

const VERDICT_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    withhold: {
      type: 'string',
      enum: ['yes', 'no'],
      description:
        'yes only when the whole draft is internal reasoning and nothing usable remains.',
    },
  },
  required: ['reason', 'withhold'],
  additionalProperties: false,
};

const verdictSchema = z.object({
  reason: z.string(),
  withhold: z.enum(['yes', 'no']),
});

const MAX_TOKENS = 256;
const TOOL_NAME = 'find_reasoning';
const TOOL_DESCRIPTION = 'Decide whether this whole nearby-find reply must be withheld.';

export function findReasoningUserMessage(draft: string): string {
  return JSON.stringify({ draft });
}

/** The judge's request shape, imported by the find-reasoning-judge eval. */
export const FIND_REASONING_TOOL = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  schema: VERDICT_SCHEMA,
  maxTokens: MAX_TOKENS,
} as const;

/**
 * The hard gate for a nearby-find reply. Verdict quality is the cached
 * find-reasoning-judge eval (apps/worker/evals), which imports this request shape.
 */
export async function judgeWholeFindReply(
  client: () => AgentClient,
  draft: string,
): Promise<FindReplyGate> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch {
    return { verdict: 'unjudged', reason: 'client_unavailable' };
  }

  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill('find-reasoning-judge');
  } catch {
    return { verdict: 'unjudged', reason: 'skill_unavailable' };
  }

  try {
    const { value } = await forceToolJson({
      client: resolved,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: findReasoningUserMessage(draft),
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      inputJsonSchema: VERDICT_SCHEMA,
      schema: verdictSchema,
      maxTokens: MAX_TOKENS,
    });
    return value.withhold === 'yes' ? { verdict: 'withhold' } : { verdict: 'send' };
  } catch {
    return { verdict: 'unjudged', reason: 'judge_failed' };
  }
}
