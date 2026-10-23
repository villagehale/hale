import { type AgentClient, pickLane, withoutThinking } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { zonedLocalInstant } from '~/lib/plan/spine';
import type { LiveRegistrationDate } from '../live-reading';

export interface OpeningFact {
  date: string;
  time: string | null;
  timeZone: string | null;
  timePublished: boolean;
}

export interface PartialOpeningFact {
  dateText: string;
  timeZone: string | null;
}

export function openingFact(
  date: LiveRegistrationDate | null,
  timeZone: string | null,
): OpeningFact | null {
  return date
    ? { date: date.date, time: date.time, timeZone, timePublished: date.time !== null }
    : null;
}

const quote = z.string().trim().min(1).nullable();
const parsedOpening = z.object({
  date: z.string().nullable(),
  time: z.string().nullable(),
  timeZone: z.string().nullable(),
  weekday: z.number().int().min(0).max(6).nullable(),
  confidence: z.enum(['high', 'low']),
  evidence: z.object({ date: quote, time: quote, timeZone: quote, weekday: quote }),
});
const schema = z.object({ openings: z.array(parsedOpening) });
type ParsedOpening = z.infer<typeof parsedOpening>;

function matches(actual: ParsedOpening, expected: OpeningFact): boolean {
  if (
    actual.date !== expected.date ||
    actual.time !== expected.time ||
    !actual.timeZone ||
    !expected.timeZone
  )
    return false;
  if (
    actual.evidence.weekday !== null &&
    actual.weekday !== null &&
    new Date(`${expected.date}T12:00:00Z`).getUTCDay() !== actual.weekday
  )
    return false;
  try {
    return (
      zonedLocalInstant(expected.date, expected.time ?? '12:00', actual.timeZone).getTime() ===
      zonedLocalInstant(expected.date, expected.time ?? '12:00', expected.timeZone).getTime()
    );
  } catch {
    return false;
  }
}

export function messageDatesMatch(
  message: string,
  openings: readonly ParsedOpening[],
  required: OpeningFact | null,
  allowed: readonly OpeningFact[] = [],
  partial: readonly PartialOpeningFact[] = [],
): boolean {
  const resolved = openings.filter((actual) => actual.date !== null);
  if (
    openings.some(
      (actual) =>
        actual.date === null &&
        !partial.some(
          (fact) =>
            actual.evidence.date === fact.dateText &&
            message.includes(fact.dateText) &&
            actual.time === null &&
            actual.evidence.time === null &&
            actual.weekday === null &&
            actual.evidence.weekday === null &&
            (actual.timeZone === null
              ? actual.evidence.timeZone === null
              : actual.timeZone === fact.timeZone &&
                actual.evidence.timeZone !== null &&
                message.includes(actual.evidence.timeZone)),
        ),
    )
  )
    return false;
  const backed = [...(required ? [required] : []), ...allowed];
  return (
    (!required || resolved.length > 0) &&
    resolved.every(
      (actual) =>
        actual.confidence === 'high' &&
        (['date', 'time', 'timeZone', 'weekday'] as const).every((key) => {
          // An optional derived weekday without a quote is not a claim in the message.
          if (key === 'weekday' && actual.evidence.weekday === null) return true;
          return actual[key] === null
            ? actual.evidence[key] === null
            : Boolean(actual.evidence[key] && message.includes(actual.evidence[key]!));
        }) &&
        backed.some((expected) => matches(actual, expected)),
    ) &&
    (!required || resolved.some((actual) => matches(actual, required)))
  );
}

/** The parser sees only the written message and clock, never the expected source values. */
export async function verifyMessageDates(
  message: string,
  now: Date,
  required: OpeningFact | null,
  allowed: readonly OpeningFact[],
  client: AgentClient,
  partial: readonly PartialOpeningFact[] = [],
  purpose: 'registration_opening' | 'waitlist_deadline' = 'registration_opening',
): Promise<boolean> {
  const skill = await loadCronSkill('registration-message-dates');
  const lane = pickLane(skill.meta.task);
  const { value } = await forceToolJson({
    client,
    lane: withoutThinking(lane) ?? lane,
    system: skill.instructions,
    userMessage: JSON.stringify({
      message,
      now: now.toISOString(),
      ...(purpose === 'waitlist_deadline' ? { purpose } : {}),
    }),
    toolName: 'registration_message_dates',
    toolDescription: 'Parse the opening dates actually expressed in the message.',
    inputJsonSchema: {
      type: 'object',
      properties: {
        openings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: ['string', 'null'] },
              time: { type: ['string', 'null'] },
              timeZone: { type: ['string', 'null'] },
              weekday: { type: ['integer', 'null'], minimum: 0, maximum: 6 },
              confidence: { type: 'string', enum: ['high', 'low'] },
              evidence: {
                type: 'object',
                properties: {
                  date: { type: ['string', 'null'] },
                  time: { type: ['string', 'null'] },
                  timeZone: { type: ['string', 'null'] },
                  weekday: { type: ['string', 'null'] },
                },
                required: ['date', 'time', 'timeZone', 'weekday'],
                additionalProperties: false,
              },
            },
            required: ['date', 'time', 'timeZone', 'weekday', 'confidence', 'evidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['openings'],
      additionalProperties: false,
    },
    schema,
    maxTokens: 1024,
  });
  return messageDatesMatch(message, value.openings, required, allowed, partial);
}
