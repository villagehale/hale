import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { MorningFacts } from './copy';

/**
 * VIL-484 · EVERY morning-of (go leg) registration text. The model writes the
 * WHOLE message from facts, whatever this morning's read found. A draft that cannot be
 * written is NOTHING SENT: there is no fallback sentence.
 */

export const REGISTRATION_MORNING_SKILL = 'registration-morning';

export interface MorningComposeInput extends MorningFacts {
  language: ReplyLanguage;
}

const URL_SHAPE = /https?:\/\/\S+/gi;

/** Structural refusals only: empty, the handed link missing, or another link. */
export function morningRefusals(body: string, facts: MorningComposeInput): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const urls = text.match(URL_SHAPE) ?? [];
  const found: string[] = [];
  if (urls.some((url) => !url.startsWith(facts.link))) found.push('other_link');
  if (!text.includes(facts.link)) found.push('link_missing');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const MORNING_MAX_ATTEMPTS = 2;
export const MORNING_MAX_TOKENS = 512;

/** The whole morning text, or null after refused or failed attempts. Null sends nothing. */
export async function composeRegistrationMorning(
  client: AgentClient,
  facts: MorningComposeInput,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_MORNING_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'registration morning: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= MORNING_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(facts),
        toolName: 'registration_morning_text',
        toolDescription: 'The one text Hale sends the parent just before registration opens.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: MORNING_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = morningRefusals(text, facts);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'registration morning: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration morning: compose failed',
      );
    }
  }
  console.error(
    { familyId, outcome: 'registration_morning_unwritten' },
    'registration morning: nothing sent',
  );
  return null;
}
