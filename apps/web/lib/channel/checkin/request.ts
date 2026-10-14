import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * IS THIS PARENT TELLING HALE ABOUT THEIR DAY, OR ASKING HALE FOR SOMETHING?
 *
 * A model reads the sentence. There is no word list and no question-mark rule.
 * The evening handler claims a sentence, and filing a request as a diary line
 * means the coach never sees it. Ambiguity resolves toward the coach.
 *
 * A missing client, a missing skill, or a model failure is unreadable, and the
 * log names which. The parent's text is never in that line. The caller treats
 * unreadable the same as a request: the coach, not a diary note.
 */

export interface EveningRequestReading {
  asks: boolean;
}

export interface EveningRequestReader {
  read(input: { text: string }): Promise<EveningRequestReading | null>;
}

/** One SMS body cannot exceed this by the time it reaches us. */
const MAX_TEXT_CHARS = 1600;

export const EVENING_REQUEST_MAX_TOKENS = 256;

export const EVENING_REQUEST_TOOL = 'evening_request';

export const eveningRequestSchema = z.object({
  asks: z.boolean(),
  reason: z.string().optional(),
});

export const EVENING_REQUEST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    asks: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['asks'],
} as const;

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function eveningRequestUserMessage(text: string): string {
  return JSON.stringify({ text });
}

export function toEveningRequestReading(raw: { asks?: unknown }): EveningRequestReading | null {
  if (typeof raw.asks !== 'boolean') return null;
  return { asks: raw.asks };
}

/**
 * Whether the evening handler should refuse the claim. A failed read is a
 * request: losing one costs the parent the thing they asked for.
 */
export function eveningReplyIsRequest(reading: EveningRequestReading | null): boolean {
  return reading === null || reading.asks;
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'evening request: unreadable');
  return null;
}

/**
 * `client` is a resolver, not a value. These deps are built for every inbound
 * text, including the ones a deterministic handler answers with no model at
 * all, so a missing key must not throw. It is unreadable, named in the log.
 */
export function createEveningRequestReader(client: () => AgentClient): EveningRequestReader {
  return {
    async read(input) {
      const bounded = input.text.slice(0, MAX_TEXT_CHARS);
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unreadable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('evening-request');
      } catch (err) {
        return unreadable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: eveningRequestUserMessage(bounded),
          toolName: EVENING_REQUEST_TOOL,
          toolDescription: 'Decide whether this message asks Hale for something.',
          inputJsonSchema: EVENING_REQUEST_TOOL_SCHEMA,
          schema: eveningRequestSchema,
          maxTokens: EVENING_REQUEST_MAX_TOKENS,
        });
        const reading = toEveningRequestReading(value);
        if (!reading) return unreadable('unreadable');
        return reading;
      } catch (err) {
        return unreadable('model_failed', message(err));
      }
    },
  };
}
