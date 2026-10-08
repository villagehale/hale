import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { PARENT_INTENTS, type ParentIntentInput, type ParentIntentReading } from './types';

const MAX_TOKENS = 256;
const MAX_TEXT_CHARS = 1600;
const MAX_TURN_CHARS = 400;

const rawSchema = z.object({
  intent: z.string(),
  confidence: z.string(),
  targetId: z.string().nullable().optional(),
  index: z.number().nullable().optional(),
  value: z.string().nullable().optional(),
  reason: z.string().optional(),
});

const rawJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...PARENT_INTENTS] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    targetId: { type: ['string', 'null'] },
    index: { type: ['number', 'null'] },
    value: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['intent', 'confidence', 'targetId', 'index', 'value', 'reason'],
} as const;

export interface ParentIntentResolver {
  read(input: ParentIntentInput): Promise<ParentIntentReading>;
}

/** The user-turn payload. Shared with the eval, which replicates this shape. */
export function parentIntentUserMessage(input: ParentIntentInput): string {
  return JSON.stringify({
    text: input.text.slice(0, MAX_TEXT_CHARS),
    recentTurns: input.recentTurns.slice(-6).map((turn) => ({
      role: turn.role,
      body: turn.body.slice(0, MAX_TURN_CHARS),
    })),
    pending: input.pending.map((item) => ({
      id: item.id,
      kind: item.kind,
      description: item.description.slice(0, 240),
    })),
  });
}

/**
 * A reading that is safe to hand on: unknown fields become `other` / `low`,
 * which the gate sends to the coach. Nothing here invents an act.
 */
export function toParentIntent(raw: {
  intent: string;
  confidence: string;
  targetId?: string | null;
  index?: number | null;
  value?: string | null;
}): ParentIntentReading {
  const intent = (PARENT_INTENTS as readonly string[]).includes(raw.intent)
    ? (raw.intent as ParentIntentReading['intent'])
    : 'other';
  const confidence =
    raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low';
  const index =
    typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index > 0
      ? raw.index
      : null;
  return {
    intent,
    confidence,
    targetId: raw.targetId?.trim() ? raw.targetId : null,
    index,
    value: raw.value?.trim() ? raw.value.trim().slice(0, 200) : null,
  };
}

function unresolved(): ParentIntentReading {
  return { intent: 'unclear', confidence: 'low', targetId: null, index: null, value: null };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/**
 * One model call. No client, no skill, or a failed call is `unclear` at `low`,
 * which the gate hands to the coach. It never becomes a guess.
 */
export function createParentIntentResolver(client: () => AgentClient): ParentIntentResolver {
  return {
    async read(input) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        console.info(
          { reason: 'client_unavailable', detail: errorName(err) },
          'parent intent: unresolved',
        );
        return unresolved();
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('parent-intent');
      } catch (err) {
        console.info(
          { reason: 'skill_unavailable', detail: errorName(err) },
          'parent intent: unresolved',
        );
        return unresolved();
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: parentIntentUserMessage(input),
          toolName: 'parent_intent',
          toolDescription:
            'Return what the parent meant, as structured fields. Do not write a reply.',
          inputJsonSchema: rawJsonSchema,
          schema: rawSchema,
          maxTokens: MAX_TOKENS,
        });
        return toParentIntent(value);
      } catch (err) {
        console.info(
          { reason: 'model_failed', detail: errorName(err) },
          'parent intent: unresolved',
        );
        return unresolved();
      }
    },
  };
}
