import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The co-parent night-before text. The model writes the WHOLE message from
 * facts, in the parent's language. A draft that cannot be written is NOTHING
 * SENT: there is no fallback sentence.
 */

export const DUTY_NIGHT_SKILL = 'duty-night';

export interface DutyNightHandoff {
  name: string;
  /** Null when no child may be named. */
  kid: string | null;
  event: string;
  /** Family-local clock, handed in English. The model restates it. */
  time: string;
  /** Family-local date, written out. */
  date: string;
}

export interface DutyNightUnowned {
  kid: string | null;
  event: string;
  day: string;
  time: string;
}

export interface DutyNightFacts {
  language: 'en' | 'fr';
  now: { date: string; time: string };
  handoff: DutyNightHandoff | null;
  /** A same-bubble event nobody has yet, or null. */
  unowned: DutyNightUnowned | null;
  /** A parent who has not answered, or null. */
  quiet: { name: string } | null;
}

export function dutyNightUserMessage(facts: DutyNightFacts): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+/i;

/** Structural refusals only: empty, or any link (none is ever handed). */
export function dutyNightRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  if (URL_SHAPE.test(text)) return ['other_link'];
  return [];
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const DUTY_NIGHT_MAX_ATTEMPTS = 2;
export const DUTY_NIGHT_MAX_TOKENS = 512;

/** The whole night-before text, or null. Null sends nothing. */
export async function composeDutyNight(
  client: AgentClient,
  facts: DutyNightFacts,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(DUTY_NIGHT_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'duty night: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= DUTY_NIGHT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: dutyNightUserMessage(facts),
        toolName: 'duty_night_text',
        toolDescription: 'The one text Hale sends the group the evening before.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: DUTY_NIGHT_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = dutyNightRefusals(text);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'duty night: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'duty night: compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'duty_night_unwritten' }, 'duty night: nothing sent');
  return null;
}
