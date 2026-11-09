import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-545 · the model reads whether the rec-morning facts answer the parent's text.
 *
 * The word test in match.ts picks WHICH facts a text might be about, and it is a word
 * test: "Saturday's swim pickup" says "swim", so a city family's pickup question got the
 * city's registration morning, in the group and in 1:1. This read, not the word test,
 * decides whether the lane speaks. Anything but `answers` leaves the turn to the coach,
 * which has the whole family context and its own rule against volunteering a window.
 *
 * One Haiku call (`task: screen`), forced strict JSON, reason before the reading, one
 * retry. A failed read returns null; the caller sends nothing from this lane.
 */

const MAX_TOKENS = 256;

export type RecMorningReading = 'answers' | 'other';

const READINGS = ['answers', 'other'] as const;

export interface RecMorningReadInput {
  text: string;
  /** The reviewed facts the lane would answer from. */
  facts: string;
  language: ReplyLanguage | null;
}

/** Null: the read failed (after its retry). */
export type RecMorningReader = (input: RecMorningReadInput) => Promise<RecMorningReading | null>;

// `reading` is a plain string here so an unknown value is dropped by code, not thrown.
const outputSchema = z.object({ reason: z.string(), reading: z.string() });

const outputJsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    reading: { type: 'string', enum: [...READINGS] },
  },
  required: ['reason', 'reading'],
  additionalProperties: false,
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function recMorningReadUserMessage(input: RecMorningReadInput): string {
  return JSON.stringify({
    text: input.text,
    facts: input.facts,
    languageHint: certainLanguageHint(input.language),
  });
}

export function acceptRecMorningReading(
  value: z.infer<typeof outputSchema>,
): RecMorningReading | null {
  return READINGS.find((reading) => reading === value.reading) ?? null;
}

export function createRecMorningReader(client: () => AgentClient): RecMorningReader {
  const once = async (input: RecMorningReadInput): Promise<RecMorningReading | null> => {
    const skill = await loadCronSkill('rec-morning-read');
    const { value } = await forceToolJson({
      client: client(),
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: recMorningReadUserMessage(input),
      toolName: 'rec_morning_read',
      toolDescription: 'Return whether these facts answer what the parent is asking.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: MAX_TOKENS,
    });
    return acceptRecMorningReading(value);
  };
  return async (input) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const reading = await once(input);
        if (reading) return reading;
      } catch (err) {
        console.error(
          { attempt, err: err instanceof Error ? err.name : 'unknown' },
          'rec-morning reader: read failed',
        );
      }
    }
    return null;
  };
}

let shared: RecMorningReader | null = null;
let sharedClient: AgentClient | undefined;

export function sharedRecMorningReader(): RecMorningReader {
  shared ??= createRecMorningReader(() => {
    sharedClient ??= budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'inbound_screen' });
    return sharedClient;
  });
  return shared;
}

/** Tests install a scripted reader here; null restores the real one. */
export function setSharedRecMorningReader(reader: RecMorningReader | null): void {
  shared = reader;
}

/** The reader's request shape, imported by the rec-morning-read eval. */
export const REC_MORNING_READ_TOOL_SCHEMA = outputJsonSchema;
export const REC_MORNING_READ_MAX_TOKENS = MAX_TOKENS;
