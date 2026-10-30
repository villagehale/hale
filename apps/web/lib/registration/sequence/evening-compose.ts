import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { EveningFacts } from './copy';

/**
 * The evening-before registration text. The model writes the WHOLE message from
 * facts, in the parent's language. Code owns the facts. A draft that cannot be
 * written is NOTHING SENT: there is no fallback sentence.
 */

export const REGISTRATION_EVENING_SKILL = 'registration-evening';

export interface EveningComposeInput extends EveningFacts {
  language: ReplyLanguage;
}

export function eveningUserMessage(facts: EveningComposeInput): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+/gi;

/** Structural refusals only: empty, or a link that was not handed. */
export function eveningRefusals(body: string, facts: EveningComposeInput): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const urls = text.match(URL_SHAPE) ?? [];
  const link = facts.link;
  const found: string[] = [];
  if (urls.some((url) => link === null || !url.startsWith(link))) found.push('other_link');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const EVENING_MAX_ATTEMPTS = 2;
export const EVENING_MAX_TOKENS = 512;

/** The whole evening text, or null after refused or failed attempts. Null sends nothing. */
export async function composeRegistrationEvening(
  client: AgentClient,
  facts: EveningComposeInput,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_EVENING_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'registration evening: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= EVENING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: eveningUserMessage(facts),
        toolName: 'registration_evening_text',
        toolDescription:
          'The one text Hale sends the parent the evening before registration opens.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: EVENING_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = eveningRefusals(text, facts);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'registration evening: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration evening: compose failed',
      );
    }
  }
  console.error(
    { familyId, outcome: 'registration_evening_unwritten' },
    'registration evening: nothing sent',
  );
  return null;
}
