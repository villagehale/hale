import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { RecHelloCity, RecMorningTopic } from './match';

/**
 * VIL-545 leftover · the model picks which rec-morning facts answer the parent's text.
 *
 * Loaded only when REC_MORNING_MODEL_TOPIC_ENABLED is exactly `true`. Off, match.ts
 * still word-tests and rec-morning-read still gates the lane, so the recorded
 * rec-morning-read eval stays byte-stable. On, this screen is the gate: the word
 * test is not consulted, and rec-morning-read is not called.
 *
 * One Haiku call (`task: screen`), forced strict JSON, reason before the topic, one
 * retry. A failed pick returns null; the caller sends nothing from this lane.
 */

const MAX_TOKENS = 256;

export type RecMorningCatalogEntry = { topic: RecMorningTopic; facts: string };

/** A catalog id, or `none` when these facts do not answer the text. */
export type RecMorningPicked = RecMorningTopic | 'none';

export interface RecMorningTopicPickInput {
  text: string;
  language: ReplyLanguage | null;
  homeCity: RecHelloCity;
  topics: readonly RecMorningCatalogEntry[];
}

/** Null: the pick failed (after its retry). */
export type RecMorningTopicPicker = (
  input: RecMorningTopicPickInput,
) => Promise<RecMorningPicked | null>;

const outputSchema = z.object({ reason: z.string(), topic: z.string() });

const outputJsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    topic: { type: 'string' },
  },
  required: ['reason', 'topic'],
  additionalProperties: false,
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function recMorningTopicUserMessage(input: RecMorningTopicPickInput): string {
  return JSON.stringify({
    text: input.text,
    languageHint: certainLanguageHint(input.language),
    homeCity: input.homeCity,
    topics: input.topics.map((entry) => ({ id: entry.topic, facts: entry.facts })),
  });
}

export function acceptRecMorningTopic(
  value: z.infer<typeof outputSchema>,
  known: readonly RecMorningTopic[],
): RecMorningPicked | null {
  if (value.topic === 'none') return 'none';
  return known.find((id) => id === value.topic) ?? null;
}

export function createRecMorningTopicPicker(client: () => AgentClient): RecMorningTopicPicker {
  const once = async (input: RecMorningTopicPickInput): Promise<RecMorningPicked | null> => {
    const skill = await loadCronSkill('rec-morning-topic');
    const known = input.topics.map((entry) => entry.topic);
    const { value } = await forceToolJson({
      client: client(),
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: recMorningTopicUserMessage(input),
      toolName: 'rec_morning_topic',
      toolDescription: 'Return the id of the facts that answer what the parent is asking, or none.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: MAX_TOKENS,
    });
    return acceptRecMorningTopic(value, known);
  };
  return async (input) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const picked = await once(input);
        if (picked) return picked;
      } catch (err) {
        console.error(
          { attempt, err: err instanceof Error ? err.name : 'unknown' },
          'rec-morning topic picker: pick failed',
        );
      }
    }
    return null;
  };
}

let shared: RecMorningTopicPicker | null = null;
let sharedClient: AgentClient | undefined;

export function sharedRecMorningTopicPicker(): RecMorningTopicPicker {
  shared ??= createRecMorningTopicPicker(() => {
    sharedClient ??= budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'inbound_screen' });
    return sharedClient;
  });
  return shared;
}

/** Tests install a scripted picker here; null restores the real one. */
export function setSharedRecMorningTopicPicker(picker: RecMorningTopicPicker | null): void {
  shared = picker;
}

/** The picker's request shape, imported by the rec-morning-topic eval. */
export const REC_MORNING_TOPIC_TOOL_SCHEMA = outputJsonSchema;
export const REC_MORNING_TOPIC_MAX_TOKENS = MAX_TOKENS;
