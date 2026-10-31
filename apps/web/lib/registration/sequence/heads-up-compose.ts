import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { HeadsUpFacts } from './copy';
import { type CheckRegistrationText, checkRegistrationText } from './text-check';

/**
 * VIL-488 · the heads-up registration text (a week out). The model writes the WHOLE
 * message from facts, the same way the morning-of text is written (VIL-484). A draft
 * that cannot be written is NOTHING SENT: there is no fallback sentence.
 */

export const REGISTRATION_HEADS_UP_SKILL = 'registration-heads-up';

export interface HeadsUpComposeInput extends HeadsUpFacts {
  language: ReplyLanguage;
}

const URL_SHAPE = /https?:\/\/\S+/gi;

/** A scheme-free web address a phone would still make tappable: `www.` anything, or a
 * bare host on a common TLD (`richmondhill.ca/programs`). Clock words such as "a.m."
 * never match: no TLD here is one letter. */
const BARE_WEB_ADDRESS =
  /\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|org|net|io|gov|edu|info|app|co|us|fr|ly|me)\b/i;

/** Structural refusals only: empty, or any link, with or without a scheme (the heads-up
 * is handed none). */
export function headsUpRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  return (text.match(URL_SHAPE) ?? []).length > 0 || BARE_WEB_ADDRESS.test(text) ? ['link'] : [];
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const HEADS_UP_MAX_ATTEMPTS = 2;
export const HEADS_UP_MAX_TOKENS = 512;

/** The whole heads-up text, or null after refused or failed attempts. Null sends nothing. */
export async function composeRegistrationHeadsUp(
  client: AgentClient,
  facts: HeadsUpComposeInput,
  familyId: string,
  options: { check?: CheckRegistrationText } = {},
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_HEADS_UP_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'registration heads-up: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= HEADS_UP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(facts),
        toolName: 'registration_heads_up_text',
        toolDescription:
          'The one text Hale sends the parent about a week before registration opens.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: HEADS_UP_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = headsUpRefusals(text);
      if (refusals.length > 0) {
        console.warn({ familyId, attempt, refusals }, 'registration heads-up: draft refused');
        continue;
      }
      // Every structurally clean draft is fact-checked before it can send (VIL-488).
      const check = await (options.check ?? checkRegistrationText)(
        client,
        'heads_up',
        facts,
        text,
        familyId,
      );
      if (check.supported) return text;
      // Claims are logged by count only: they can quote family words.
      console.warn(
        { familyId, attempt, unsupported: check.unsupported.length },
        'registration heads-up: draft failed the fact check',
      );
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration heads-up: compose failed',
      );
    }
  }
  console.error(
    { familyId, outcome: 'registration_heads_up_unwritten' },
    'registration heads-up: nothing sent',
  );
  return null;
}
