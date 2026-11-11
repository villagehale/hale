import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { asBubbles } from './bubbles';
import type { PlanPrepFacts, PlanPrepWriter } from './prep';
import { planReplyText, planReplyViolations } from './writer';

export const SIGNUP_PROVIDER_NOTICE_SKILL = 'signup-provider-notice';
export const SIGNUP_PROVIDER_NOTICE_TOOL = 'signup_provider_notice';
export const SIGNUP_PROVIDER_NOTICE_MAX_TOKENS = 800;
export const signupProviderNoticeSchema = z
  .object({
    bubbles: z.array(z.string()).min(1).optional(),
    text: z.string().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.bubbles?.length || value.text?.trim()), {
    message: 'bubbles or text',
  });
export const SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    bubbles: { type: 'array', items: { type: 'string' } },
  },
  required: ['bubbles'],
  additionalProperties: false,
} as const;

export function createProviderNoticeWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): PlanPrepWriter {
  return {
    async write(facts: PlanPrepFacts) {
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch {
        return null;
      }
      if (!resolved) return null;
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_PROVIDER_NOTICE_SKILL);
      } catch {
        return null;
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: JSON.stringify({ facts }),
          toolName: SIGNUP_PROVIDER_NOTICE_TOOL,
          toolDescription: 'Write the short registration bubbles the parent sees.',
          inputJsonSchema: SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA,
          schema: signupProviderNoticeSchema,
          maxTokens: SIGNUP_PROVIDER_NOTICE_MAX_TOKENS,
        });
        const bubbles = asBubbles(value.bubbles ?? value.text ?? null);
        if (!bubbles) return null;
        const sent = bubbles.map(planReplyText);
        if (sent.some((text) => planReplyViolations(text).length > 0)) return null;
        return sent;
      } catch {
        return null;
      }
    },
  };
}
