import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
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
  nowIso: string;
  timeZone: string;
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface CarpoolReader {
  read(input: CarpoolReadInput): Promise<CarpoolReading>;
}

const readingSchema = z.object({
  intent: z.enum(CARPOOL_INTENTS),
  driverName: z.string().nullable(),
  eventLabel: z.string().nullable(),
  pickupAtIso: z.string().nullable(),
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
    eventLabel: { type: ['string', 'null'] },
    pickupAtIso: { type: ['string', 'null'] },
    pickupPlace: { type: ['string', 'null'] },
    kids: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: [
    'intent',
    'driverName',
    'eventLabel',
    'pickupAtIso',
    'pickupPlace',
    'kids',
    'confidence',
  ],
} as const;

const UNCLEAR: CarpoolReading = {
  intent: 'unclear',
  driverName: null,
  eventLabel: null,
  pickupAtIso: null,
  pickupPlace: null,
  kids: null,
  confidence: 'low',
};

export function carpoolUserMessage(input: CarpoolReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    memberNames: [...input.memberNames],
    currentDriver: input.currentDriver,
    nowIso: input.nowIso,
    timeZone: input.timeZone,
    recent: input.recent.slice(-8),
  });
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
    eventLabel: empty(parsed.data.eventLabel),
    pickupAtIso: empty(parsed.data.pickupAtIso),
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
    eventLabel: null,
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
