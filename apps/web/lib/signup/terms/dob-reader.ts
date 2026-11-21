import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { acceptCalendarDate } from '~/lib/channel/intake/calendar-date';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { quotesParentWords } from '../parent-quote';

/**
 * VIL-715 · the child's date of birth, from the parent's answer to Hale asking for it.
 * The model reads it; code holds it to the parent's own words: their quote is copied whole,
 * carries the date's day and year, and the date is a real day in the past. Anything else
 * reads as no date, and the turn carries on as usual.
 */
export const SIGNUP_DOB_READ_SKILL = 'signup-dob-read';
export const SIGNUP_DOB_READ_TOOL = 'signup_dob_read';
export const SIGNUP_DOB_READ_TOOL_DESCRIPTION =
  "Return the child's date of birth if the parent's message states it, with their words.";
export const SIGNUP_DOB_READ_MAX_TOKENS = 400;

export const signupDobReadSchema = z
  .object({ said: z.string().nullable(), date: z.string().nullable() })
  .strict();

export const SIGNUP_DOB_READ_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    said: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
  },
  required: ['said', 'date'],
} as const;

export interface DobReader {
  read(input: { text: string }): Promise<z.infer<typeof signupDobReadSchema> | null>;
}

/** The date, once the parent's own words back it. Pure. */
export function acceptDobReading(
  raw: z.infer<typeof signupDobReadSchema>,
  text: string,
  now: Date,
): string | null {
  if (raw.said === null || raw.date === null) return null;
  const date = acceptCalendarDate(raw.date);
  if (date === null || !quotesParentWords(text, raw.said)) return null;
  if (new Date(`${date}T12:00:00Z`).getTime() >= now.getTime()) return null;
  const said = raw.said.normalize('NFKC');
  const year = date.slice(0, 4);
  const day = String(Number(date.slice(8, 10)));
  const digits = said.match(/\d+/g) ?? [];
  const hasYear = digits.includes(year) || digits.includes(year.slice(2));
  const hasDay = digits.some((run) => run === day || run === day.padStart(2, '0'));
  return hasYear && hasDay ? date : null;
}

export function createDobReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): DobReader {
  return {
    async read(input) {
      const resolved = await client();
      if (!resolved) return null;
      const skill = await loadCronSkill(SIGNUP_DOB_READ_SKILL);
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: JSON.stringify({ text: input.text }),
          toolName: SIGNUP_DOB_READ_TOOL,
          toolDescription: SIGNUP_DOB_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_DOB_READ_TOOL_SCHEMA,
          schema: signupDobReadSchema,
          maxTokens: SIGNUP_DOB_READ_MAX_TOKENS,
        });
        return value;
      } catch (err) {
        console.info(
          { reason: 'model_failed', detail: err instanceof Error ? err.constructor.name : 'unknown' },
          'signup dob read: unread',
        );
        return null;
      }
    },
  };
}
