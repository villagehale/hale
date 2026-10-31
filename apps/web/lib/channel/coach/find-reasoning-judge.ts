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

/**
 * The hard gate for a nearby-find reply. A dry client is enough to prove the
 * request: answer quality is a cached eval, not wired until it can be re-recorded
 * without a live spend.
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
      userMessage: JSON.stringify({ draft }),
      toolName: 'find_reasoning',
      toolDescription: 'Decide whether this whole nearby-find reply must be withheld.',
      inputJsonSchema: VERDICT_SCHEMA,
      schema: verdictSchema,
      maxTokens: MAX_TOKENS,
    });
    return value.withhold === 'yes' ? { verdict: 'withhold' } : { verdict: 'send' };
  } catch {
    return { verdict: 'unjudged', reason: 'judge_failed' };
  }
}
