import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { acceptCalendarDate } from '~/lib/channel/intake/calendar-date';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { quotesParentWords } from '../parent-quote';

/**
 * VIL-715 · the child's date of birth, from the parent's answer to Hale asking for it.
 * The model reads it, for this child by name; code holds it to the parent's own words: their
 * quote is copied whole, carries the date's year, month and day each in its own word, and
 * the date is a real day in the past. A date the model reads as someone else's is never
 * stored. Anything else reads as no date.
 */
export const SIGNUP_DOB_READ_SKILL = 'signup-dob-read';
export const SIGNUP_DOB_READ_TOOL = 'signup_dob_read';
export const SIGNUP_DOB_READ_TOOL_DESCRIPTION =
  "Return the child's date of birth if the parent's message states it, with their words.";
export const SIGNUP_DOB_READ_MAX_TOKENS = 400;

export const signupDobReadSchema = z
  .object({
    said: z.string().nullable(),
    date: z.string().nullable(),
    otherPerson: z.boolean(),
  })
  .strict();

export const SIGNUP_DOB_READ_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    said: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    otherPerson: { type: 'boolean' },
  },
  required: ['said', 'date', 'otherPerson'],
} as const;

export interface DobReader {
  read(input: {
    text: string;
    /** The child Hale asked about. A date given for anyone else is not theirs. */
    childFirstName: string;
  }): Promise<z.infer<typeof signupDobReadSchema> | null>;
}

export function signupDobReadUserMessage(input: { text: string; childFirstName: string }): string {
  return JSON.stringify({ child_first_name: input.childFirstName, text: input.text });
}

/** The date, once the parent's own words back it. Pure. */
export function acceptDobReading(
  raw: z.infer<typeof signupDobReadSchema>,
  text: string,
  now: Date,
): string | null {
  if (raw.otherPerson || raw.said === null || raw.date === null) return null;
  const date = acceptCalendarDate(raw.date);
  if (date === null || !quotesParentWords(text, raw.said)) return null;
  if (new Date(`${date}T12:00:00Z`).getTime() >= now.getTime()) return null;
  return quoteCarriesDate(raw.said, date) ? date : null;
}

/** The month's names in the two languages Hale writes to parents in, from the platform. */
function monthNames(monthIndex: number): string[] {
  const at = new Date(Date.UTC(2024, monthIndex, 15));
  return ['en', 'fr'].flatMap((locale) =>
    (['long', 'short'] as const).map((month) =>
      new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' })
        .format(at)
        .toLowerCase()
        .replace(/\.$/, ''),
    ),
  );
}

const sameNumber = (word: string, value: string) =>
  /^\d+$/.test(word) && Number(word) === Number(value);

/**
 * Year, month and day each come from a different word of the quote. Two all-number parts
 * that could trade places (03/04/2021) do not say which is the month, unless the year leads.
 */
function quoteCarriesDate(said: string, date: string): boolean {
  const words: string[] =
    said
      .normalize('NFKC')
      .toLowerCase()
      .match(/\d+|\p{L}+/gu) ?? [];
  const [year, month, day] = [date.slice(0, 4), date.slice(5, 7), date.slice(8, 10)] as [
    string,
    string,
    string,
  ];
  const names = monthNames(Number(month) - 1);
  const fullYearAt = words.indexOf(year);
  const yearAt = fullYearAt >= 0 ? fullYearAt : words.lastIndexOf(year.slice(2));
  if (yearAt < 0) return false;
  const rest = words.map((word, index) => (index === yearAt ? null : word));
  const namedMonth = rest.findIndex((word) => word !== null && names.includes(word));
  const monthAt =
    namedMonth >= 0
      ? namedMonth
      : rest.findIndex((word) => word !== null && sameNumber(word, month));
  if (monthAt < 0) return false;
  const dayAt = rest.findIndex(
    (word, index) => index !== monthAt && word !== null && sameNumber(word, day),
  );
  if (dayAt < 0) return false;
  const swappable = namedMonth < 0 && month !== day && Number(day) <= 12;
  return !swappable || fullYearAt === 0;
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
          userMessage: signupDobReadUserMessage(input),
          toolName: SIGNUP_DOB_READ_TOOL,
          toolDescription: SIGNUP_DOB_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_DOB_READ_TOOL_SCHEMA,
          schema: signupDobReadSchema,
          maxTokens: SIGNUP_DOB_READ_MAX_TOKENS,
        });
        return value;
      } catch (err) {
        console.info(
          {
            reason: 'model_failed',
            detail: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'signup dob read: unread',
        );
        return null;
      }
    },
  };
}
