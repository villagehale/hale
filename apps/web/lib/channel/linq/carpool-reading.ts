import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';
import type { CarpoolReading } from './carpool-apply';
import type { CarpoolIntent } from './carpool-cadence';

/**
 * VIL-445 — the model reads who is driving from the group thread.
 *
 * Code never matches words. A failed read is `unclear` and changes nothing.
 * Tapbacks on Hale's ask are a structured yes from that person, not a keyword.
 */

export const CARPOOL_READ_ATTEMPTS = 2;
export const CARPOOL_READING_MAX_TOKENS = 300;

export const CARPOOL_INTENTS = [
  'driver_claim',
  'driver_swap',
  'plan_needs_driver',
  'cancel',
  'chatter',
  'unclear',
] as const satisfies readonly CarpoolIntent[];

const YES_TAPBACKS = new Set(['like', 'love', 'emphasize', 'yes', 'heart', 'thumbs_up']);

export interface CarpoolReadInput {
  text: string;
  senderName: string | null;
  memberNames: readonly string[];
  currentDriver: string | null;
  /** Instant the message arrived. The payload converts this in `timeZone`. */
  now: Date;
  timeZone: string;
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface CarpoolReader {
  read(input: CarpoolReadInput): Promise<CarpoolReading>;
}

const readingSchema = z.object({
  intent: z.enum(CARPOOL_INTENTS),
  driverName: z.string().nullable(),
  driverIsSender: z.boolean().default(false),
  eventLabel: z.string().nullable(),
  pickupDate: z.string().nullable().optional(),
  pickupTime: z.string().nullable().optional(),
  pickupAtIso: z.string().nullable().optional(),
  pickupPlace: z.string().nullable(),
  kids: z.string().nullable(),
  confidence: z.enum(['high', 'low']),
});

const readingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...CARPOOL_INTENTS] },
    driverName: { type: ['string', 'null'] },
    driverIsSender: { type: 'boolean' },
    eventLabel: { type: ['string', 'null'] },
    pickupDate: {
      type: ['string', 'null'],
      description: 'YYYY-MM-DD copied from now.nextDays, or null.',
    },
    pickupTime: {
      type: ['string', 'null'],
      description: 'HH:MM wall clock in timeZone, 24-hour, or null. No offset.',
    },
    pickupPlace: { type: ['string', 'null'] },
    kids: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: [
    'intent',
    'driverName',
    'driverIsSender',
    'eventLabel',
    'pickupDate',
    'pickupTime',
    'pickupPlace',
    'kids',
    'confidence',
  ],
} as const;

const UNCLEAR: CarpoolReading = {
  intent: 'unclear',
  driverName: null,
  eventLabel: null,
  pickupDate: null,
  pickupTime: null,
  pickupAtIso: null,
  pickupPlace: null,
  kids: null,
  confidence: 'low',
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function weekdayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(instant);
}

/**
 * `now` as the reader sees it. The date is the family's local calendar day, so
 * a Friday after 8pm Toronto (already Saturday in UTC) still names Friday, and
 * tomorrow is Saturday. The model must not add a day to a UTC timestamp.
 */
export function carpoolReaderNow(
  now: Date,
  timeZone: string,
): {
  date: string;
  weekday: string;
  time: string;
  nextDays: { date: string; weekday: string }[];
} {
  const today = dayKeyIn(now, timeZone);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(now);
  const nextDays = Array.from({ length: 8 }, (_, i) => {
    const date = addDaysToKey(today, i);
    return { date, weekday: weekdayIn(new Date(`${date}T12:00:00Z`), 'UTC') };
  });
  return { date: today, weekday: weekdayIn(now, timeZone), time, nextDays };
}

export function carpoolUserMessage(input: CarpoolReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    memberNames: [...input.memberNames],
    currentDriver: input.currentDriver,
    now: carpoolReaderNow(input.now, input.timeZone),
    timeZone: input.timeZone,
    recent: input.recent.slice(-8),
  });
}

function localDay(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return DAY_KEY.test(trimmed) ? trimmed : null;
}

function localClock(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return CLOCK.test(trimmed) ? trimmed : null;
}

export function parseCarpoolReading(value: unknown): CarpoolReading {
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) return UNCLEAR;
  const empty = (value: string | null) => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    intent: parsed.data.intent,
    driverName: empty(parsed.data.driverName),
    driverIsSender: parsed.data.driverIsSender === true,
    eventLabel: empty(parsed.data.eventLabel),
    pickupDate: localDay(parsed.data.pickupDate),
    pickupTime: localClock(parsed.data.pickupTime),
    pickupAtIso: empty(parsed.data.pickupAtIso ?? null),
    pickupPlace: empty(parsed.data.pickupPlace),
    kids: empty(parsed.data.kids),
    confidence: parsed.data.confidence,
  };
}

/** A heart or thumbs-up on Hale's driver ask is that person taking the drive. */
export function readingFromTapback(input: {
  reactionType: string | null;
  reactorName: string | null;
  onAsk: boolean;
}): CarpoolReading | null {
  if (!input.onAsk) return null;
  const kind = (input.reactionType ?? '').trim().toLowerCase();
  if (!YES_TAPBACKS.has(kind)) return null;
  const name = input.reactorName?.trim() || null;
  if (!name) return UNCLEAR;
  return {
    intent: 'driver_claim',
    driverName: name,
    // The reactor answered Hale's ask themself.
    driverIsSender: true,
    eventLabel: null,
    pickupDate: null,
    pickupTime: null,
    pickupAtIso: null,
    pickupPlace: null,
    kids: null,
    confidence: 'high',
  };
}

export function createCarpoolReader(
  clientOrResolver: (() => ReturnType<typeof budgetedAnthropic>) | CarpoolReader = () =>
    budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS),
): CarpoolReader {
  if (typeof clientOrResolver === 'object') return clientOrResolver;
  const clientOf = clientOrResolver;
  const once = async (input: CarpoolReadInput): Promise<CarpoolReading> => {
    const skill = await loadCronSkill('carpool-reading');
    const { value } = await forceToolJson({
      client: clientOf(),
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: carpoolUserMessage(input),
      toolName: 'carpool_reading',
      toolDescription: 'Who is driving after this group message.',
      inputJsonSchema: readingJsonSchema,
      schema: readingSchema,
      maxTokens: CARPOOL_READING_MAX_TOKENS,
    });
    return parseCarpoolReading(value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= CARPOOL_READ_ATTEMPTS; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading.intent !== 'unclear' || reading.confidence === 'high') return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'carpool reader: read failed',
          );
        }
      }
      console.error({ outcome: 'carpool_unread' }, 'carpool reader: leaving the plan unchanged');
      return UNCLEAR;
    },
  };
}

let shared: CarpoolReader | null = null;

export function sharedCarpoolReader(): CarpoolReader {
  shared ??= createCarpoolReader();
  return shared;
}

export const CARPOOL_READING_TOOL_SCHEMA = readingJsonSchema;
