import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-156 · the model reads a disconnect before anything ends.
 *
 * A texted disconnect now revokes Hale's whole Google grant, which only a fresh consent
 * restores, so a question about disconnecting ("how do I disconnect my calendar?") must
 * never be taken as one. The regex in detect.ts still picks which turns are read (a
 * named follow-up replaces it); this read, not the regex, decides whether to act.
 *
 * One Haiku call (`task: screen`), forced strict JSON, reason before the reading, one
 * retry. A failed read returns null and the caller ends nothing and sends nothing.
 */

const MAX_TOKENS = 256;

export type DisconnectReading = 'disconnect' | 'question' | 'other';

const READINGS = ['disconnect', 'question', 'other'] as const;

export interface DisconnectReadInput {
  text: string;
  language: ReplyLanguage | null;
}

export interface DisconnectReader {
  /** Null: the read failed (after its retry). */
  read(input: DisconnectReadInput): Promise<DisconnectReading | null>;
}

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
export function disconnectReadUserMessage(input: DisconnectReadInput): string {
  return JSON.stringify({ text: input.text, languageHint: certainLanguageHint(input.language) });
}

export function acceptDisconnectReading(
  value: z.infer<typeof outputSchema>,
): DisconnectReading | null {
  return READINGS.find((reading) => reading === value.reading) ?? null;
}

export function createDisconnectReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): DisconnectReader {
  const once = async (input: DisconnectReadInput): Promise<DisconnectReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('connector-disconnect-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: disconnectReadUserMessage(input),
      toolName: 'disconnect_read',
      toolDescription: 'Return whether the parent is asking Hale to disconnect now.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: MAX_TOKENS,
    });
    return acceptDisconnectReading(value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.error(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'disconnect reader: read failed',
          );
        }
      }
      return null;
    },
  };
}

/** The reader's request shape, imported by the connector-disconnect-read eval. */
export const DISCONNECT_READ_TOOL_SCHEMA = outputJsonSchema;
export const DISCONNECT_READ_MAX_TOKENS = MAX_TOKENS;
