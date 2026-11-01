import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { SaidLineFact } from './said-line';

/**
 * VIL-530. Whether a said-line draft carries every `mustConvey` meaning.
 * `omit` means at least one meaning is absent, so the parent is sent nothing.
 * The judge does not rewrite. `unjudged` is the same outcome under a named
 * fault (rule #11): the gate did not run, so the draft does not go out.
 */
export type ConveyGate =
  | { verdict: 'send' }
  | { verdict: 'omit' }
  | {
      verdict: 'unjudged';
      reason: 'client_unavailable' | 'skill_unavailable' | 'judge_failed';
    };

export interface ConveyFact {
  readonly key: string;
  readonly meaning: SaidLineFact;
}

export const SAID_LINE_CONVEY_TOOL = 'said_line_convey';
export const SAID_LINE_CONVEY_DESCRIPTION =
  'Decide whether this text carries every required meaning. Do not rewrite it.';
export const SAID_LINE_CONVEY_MAX_TOKENS = 256;

export const SAID_LINE_CONVEY_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'One short clause for the decision. Not a sentence for the parent.',
    },
    conveyed: {
      type: 'string',
      enum: ['yes', 'no'],
      description: 'yes only when every required meaning is in the draft.',
    },
  },
  required: ['reason', 'conveyed'],
  additionalProperties: false,
};

const verdictSchema = z.object({
  reason: z.string(),
  conveyed: z.enum(['yes', 'no']),
});

/** The judge's user turn. Shared with the eval, which replays this request. */
export function saidLineConveyUserMessage(draft: string, facts: readonly ConveyFact[]): string {
  return JSON.stringify({
    draft,
    mustConvey: facts.map((fact) => ({ key: fact.key, meaning: fact.meaning })),
  });
}

/**
 * The request the judge sends. Loading it does not call a model. The eval's
 * dry run prices this shape; a live run replays it.
 */
export async function saidLineConveyRequest(draft: string, facts: readonly ConveyFact[]) {
  const skill = await loadCronSkill('said-line-convey-judge');
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: saidLineConveyUserMessage(draft, facts),
    toolName: SAID_LINE_CONVEY_TOOL,
    toolDescription: SAID_LINE_CONVEY_DESCRIPTION,
    toolSchema: SAID_LINE_CONVEY_SCHEMA,
    maxTokens: SAID_LINE_CONVEY_MAX_TOKENS,
  };
}

/**
 * Hard gate for a said-line that names meanings it must carry. A dry client
 * proves the request. Whether a real model reads the meaning is a cached eval,
 * not a live spend from this process.
 */
export async function judgeSaidLineConvey(
  client: () => AgentClient,
  draft: string,
  facts: readonly ConveyFact[],
): Promise<ConveyGate> {
  let resolved: AgentClient;
  try {
    resolved = client();
  } catch {
    return { verdict: 'unjudged', reason: 'client_unavailable' };
  }

  let request: Awaited<ReturnType<typeof saidLineConveyRequest>>;
  try {
    request = await saidLineConveyRequest(draft, facts);
  } catch {
    return { verdict: 'unjudged', reason: 'skill_unavailable' };
  }

  try {
    const { value } = await forceToolJson({
      client: resolved,
      lane: request.lane,
      system: request.system,
      userMessage: request.userMessage,
      toolName: request.toolName,
      toolDescription: request.toolDescription,
      inputJsonSchema: request.toolSchema,
      schema: verdictSchema,
      maxTokens: request.maxTokens,
    });
    return value.conveyed === 'yes' ? { verdict: 'send' } : { verdict: 'omit' };
  } catch {
    return { verdict: 'unjudged', reason: 'judge_failed' };
  }
}
