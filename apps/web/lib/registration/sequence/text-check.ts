import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-488 / VIL-489 · the fact check on a model-written registration text (heads-up and
 * morning-of), before it can send. Same shape as the co-parent night-before check
 * (duty-night-check.md): a second model call reads the draft's MEANING against the
 * facts the writer was handed, so a false "spot held", "registered for you" or a wrong
 * open day/time is caught in any language. This is not a word list. Anything but a
 * clean pass (an unbacked claim, a failed or malformed check) is not sendable.
 */

export const REGISTRATION_TEXT_CHECK_SKILL = 'registration-text-check';
export const REGISTRATION_TEXT_CHECK_MAX_TOKENS = 2048;

export interface RegistrationTextCheck {
  supported: boolean;
  unsupported: string[];
}

const checkSchema = z.object({
  supported: z.boolean(),
  unsupported: z.array(z.string()),
});
export const REGISTRATION_TEXT_CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    unsupported: { type: 'array', items: { type: 'string' } },
  },
  required: ['supported', 'unsupported'],
} as const;

export function registrationTextCheckMessage(
  kind: 'heads_up' | 'morning',
  facts: unknown,
  text: string,
): string {
  return JSON.stringify({ text_kind: kind, facts, draft: text });
}

export type CheckRegistrationText = (
  client: AgentClient,
  kind: 'heads_up' | 'morning',
  facts: unknown,
  text: string,
  familyId: string,
) => Promise<RegistrationTextCheck>;

export const checkRegistrationText: CheckRegistrationText = async (
  client,
  kind,
  facts,
  text,
  familyId,
) => {
  try {
    const skill = await loadCronSkill(REGISTRATION_TEXT_CHECK_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: registrationTextCheckMessage(kind, facts, text),
      toolName: 'registration_text_check',
      toolDescription: 'Whether every claim in the draft is backed by the facts.',
      inputJsonSchema: REGISTRATION_TEXT_CHECK_JSON_SCHEMA,
      schema: checkSchema,
      maxTokens: REGISTRATION_TEXT_CHECK_MAX_TOKENS,
    });
    const supported = value.supported && value.unsupported.length === 0;
    return { supported, unsupported: value.unsupported };
  } catch (err) {
    console.warn(
      { familyId, kind, err: err instanceof Error ? err.name : 'unknown' },
      'registration text: fact check failed, not sendable',
    );
    return { supported: false, unsupported: ['check_failed'] };
  }
};
