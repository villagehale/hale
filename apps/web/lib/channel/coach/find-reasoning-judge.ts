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
  | { verdict: 'unjudged'; reason: JudgeFault };

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
  const judged = await runJudge(
    client,
    'find-reasoning-judge',
    FIND_REASONING_TOOL,
    verdictSchema,
    draft,
  );
  if (!judged.ok) return { verdict: 'unjudged', reason: judged.reason };
  return judged.value.withhold === 'yes' ? { verdict: 'withhold' } : { verdict: 'send' };
}

/**
 * Whether an activity follow-up carries sentences that report Hale's own search instead of
 * a find or the next step (VIL-571). `reports_process` names them so the composer can be
 * told which to drop; the judge does not rewrite. `unjudged` is a named fault (rule #11):
 * the gate did not run, so the draft does not go out.
 */
export type FollowUpProcessGate =
  | { verdict: 'clean' }
  | { verdict: 'reports_process'; sentences: string[] }
  | { verdict: 'unjudged'; reason: JudgeFault };

const PROCESS_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    process_sentences: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Each sentence of the draft that reports the search rather than a find or the next step, copied exactly. Empty when there is none.',
    },
  },
  required: ['reason', 'process_sentences'],
  additionalProperties: false,
};

const processSchema = z.object({
  reason: z.string(),
  process_sentences: z.array(z.string()),
});

/** The follow-up judge's request shape, imported by the find-reasoning-judge eval. */
export const FOLLOWUP_PROCESS_TOOL = {
  name: 'followup_process',
  description: 'Point at the sentences of this follow-up that report the search, not a find.',
  schema: PROCESS_SCHEMA,
  maxTokens: 512,
} as const;

export async function judgeFollowUpProcess(
  client: () => AgentClient,
  draft: string,
): Promise<FollowUpProcessGate> {
  const judged = await runJudge(
    client,
    'followup-process-judge',
    FOLLOWUP_PROCESS_TOOL,
    processSchema,
    draft,
  );
  if (!judged.ok) return { verdict: 'unjudged', reason: judged.reason };
  const sentences = judged.value.process_sentences.filter((sentence) => sentence.trim() !== '');
  return sentences.length === 0 ? { verdict: 'clean' } : { verdict: 'reports_process', sentences };
}

type JudgeFault = 'client_unavailable' | 'skill_unavailable' | 'judge_failed';

async function runJudge<T>(
  client: () => AgentClient,
  skillName: string,
  tool: {
    name: string;
    description: string;
    schema: Anthropic.Tool.InputSchema;
    maxTokens: number;
  },
  schema: z.ZodType<T>,
  draft: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: JudgeFault }> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch {
    return { ok: false, reason: 'client_unavailable' };
  }

  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(skillName);
  } catch {
    return { ok: false, reason: 'skill_unavailable' };
  }

  try {
    const { value } = await forceToolJson({
      client: resolved,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: findReasoningUserMessage(draft),
      toolName: tool.name,
      toolDescription: tool.description,
      inputJsonSchema: tool.schema,
      schema,
      maxTokens: tool.maxTokens,
    });
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'judge_failed' };
  }
}
