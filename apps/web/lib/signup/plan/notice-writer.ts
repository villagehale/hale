import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanPrepFacts, PlanPrepWriter } from './prep';
import { planReplyText, planReplyViolations } from './writer';

export const SIGNUP_PROVIDER_NOTICE_SKILL = 'signup-provider-notice';
export const SIGNUP_PROVIDER_NOTICE_TOOL = 'signup_provider_notice';

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
          toolDescription: 'Write the one registration notice the parent sees.',
          inputJsonSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          schema: z.object({ text: z.string() }).strict(),
          maxTokens: 400,
        });
        const text = planReplyText(value.text);
        if (planReplyViolations(text).length > 0) return null;
        return text;
      } catch {
        return null;
      }
    },
  };
}
