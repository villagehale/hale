import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-237 · M2 — reading a parent's free-text reply to the watch-offer as assent,
 * decline, or ambiguous. Prompt is the `reply-intent` SKILL body (rule #2).
 *
 * Tiered with `classify` (not `simple-lookup`) on purpose: this is the determination
 * a CONSENT record is written from, and the model matrix showed the cheap tier losing
 * exactly the safety-relevant distinctions. A consent call is not the place to save a
 * tenth of a cent.
 *
 * VERBATIM PASSTHROUGH is a structural check, not decoration: the skill must copy the
 * reply back character-for-character, and a mismatch collapses the reading to
 * `ambiguous` here. A model that paraphrased the parent's words did not read the reply
 * it was given, and its verdict is not evidence of anything.
 */

const MAX_TOKENS = 256;

export type ReplyIntent = 'assent' | 'decline' | 'ambiguous';

export interface IntentReading {
  intent: ReplyIntent;
  /** The parent's own words, as the consent record will store them. */
  verbatim: string;
  interpretation: string;
}

export interface ReplyIntentReader {
  read(input: { question: string; reply: string }): Promise<IntentReading>;
}

const INTENTS = ['assent', 'decline', 'ambiguous'] as const satisfies readonly ReplyIntent[];
const intentSchema = z.enum(INTENTS);

const intentOutputSchema = z.object({
  intent: intentSchema,
  verbatim: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});

const intentOutputJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: intentSchema.options },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function intentUserMessage(input: { question: string; reply: string }): string {
  return JSON.stringify({ question: input.question, reply: input.reply });
}

/**
 * Collapse a reading to `ambiguous` unless the model echoed the reply exactly. The
 * conservative direction is deliberate: a failed echo must never be able to produce
 * an `assent`, and downgrading costs at most one clarifying question.
 */
export function applyVerbatimGuard(reading: IntentReading, reply: string): IntentReading {
  if (reading.verbatim === reply) return reading;
  return {
    intent: 'ambiguous',
    verbatim: reply,
    interpretation: 'verbatim mismatch — the reading was discarded',
  };
}

export function createReplyIntentReader(client: AgentClient): ReplyIntentReader {
  return {
    async read(input) {
      const skill = await loadCronSkill('reply-intent');
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: intentUserMessage(input),
        toolName: 'intent',
        toolDescription: "Return how the parent's reply reads.",
        inputJsonSchema: intentOutputJsonSchema,
        schema: intentOutputSchema,
        maxTokens: MAX_TOKENS,
      });

      return applyVerbatimGuard(
        { intent: value.intent, verbatim: value.verbatim, interpretation: value.rationale },
        input.reply,
      );
    },
  };
}
