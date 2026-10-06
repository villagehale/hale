import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadGroupRoleReadingSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson, llmTransport } from '~/lib/pipeline/structured';
import { ROSTER_ROLE_MODEL_ANSWERS, type RosterRoleClassifier } from './roster-reading';

/**
 * The model half of reading a roster reply (skill `group-role-reading`, `screen` lane).
 * It sees only what the cues in roster-reading.ts could not decide, and only the words
 * of that one reply: no names, no phone, no family. Its answer is an enum and a
 * confidence; `acceptRosterRoleVerdict` decides what counts.
 */

const verdictSchema = z
  .object({ role: z.enum(ROSTER_ROLE_MODEL_ANSWERS), confidence: z.number().min(0).max(1) })
  .strict();

const verdictJsonSchema = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: [...ROSTER_ROLE_MODEL_ANSWERS] },
    confidence: { type: 'number' },
  },
  required: ['role', 'confidence'],
} as const;

const CLASSIFIER_MAX_TOKENS = 100;

export function createRosterRoleClassifier(client: AgentClient): RosterRoleClassifier {
  return {
    async classify(input) {
      const skill = await loadGroupRoleReadingSkill();
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({ reply: input.text }),
        toolName: 'role',
        toolDescription:
          'Return who this person said they are in the family, and how sure you are.',
        inputJsonSchema: verdictJsonSchema,
        schema: verdictSchema,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        transport: llmTransport(),
      });
      return value;
    },
  };
}

let defaultClassifier: RosterRoleClassifier | undefined;

/**
 * The production classifier, built once. `undefined` with no model key: a reply the cues
 * cannot read is then `unclear` via `classifier_unavailable`, and gets the one re-ask.
 */
export function defaultRosterRoleClassifier(): RosterRoleClassifier | undefined {
  if (defaultClassifier) return defaultClassifier;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  defaultClassifier = createRosterRoleClassifier(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return defaultClassifier;
}
