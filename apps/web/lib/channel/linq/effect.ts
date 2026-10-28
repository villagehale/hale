import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqEffectsEnabled } from './config';
import {
  LINQ_BUBBLE_EFFECTS,
  LINQ_SCREEN_EFFECTS,
  type LinqMessageEffect,
  LinqSendError,
  isLinqMessageEffect,
  sendLinqEffect,
} from './transport';

/**
 * VIL-473 — an iMessage screen or bubble effect on Hale's reply, when the model
 * says one fits.
 *
 * Behind `LINQ_EFFECTS_ENABLED`, exactly `true` (default off). The `linq-effect`
 * skill reads the parent's message and the reply Hale already wrote, and returns
 * the effect or none. Code never picks an effect and has no fallback one: a
 * failed or unusable read sends the reply as a plain bubble.
 */

export { linqEffectsEnabled };

export interface LinqEffectInput {
  audience: 'direct' | 'group';
  parentText: string;
  reply: string;
}

export interface LinqEffectDecision {
  effect: LinqMessageEffect | null;
}

export interface LinqEffectDecider {
  /** Null: the read failed or came back unusable. The reply goes out plain. */
  decide(input: LinqEffectInput): Promise<LinqEffectDecision | null>;
}

export const LINQ_EFFECT_TOOL = 'linq_effect';
export const LINQ_EFFECT_MAX_TOKENS = 400;
export const LINQ_EFFECT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    effect: {
      type: ['object', 'null'],
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'screen' },
            name: { type: 'string', enum: [...LINQ_SCREEN_EFFECTS] },
          },
          required: ['type', 'name'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'bubble' },
            name: { type: 'string', enum: [...LINQ_BUBBLE_EFFECTS] },
          },
          required: ['type', 'name'],
        },
      ],
    },
  },
  required: ['effect'],
} as const;

const outputSchema = z.object({
  effect: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('screen'), name: z.enum(LINQ_SCREEN_EFFECTS) }),
      z.object({ type: z.literal('bubble'), name: z.enum(LINQ_BUBBLE_EFFECTS) }),
    ])
    .nullable(),
});

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function linqEffectUserMessage(input: LinqEffectInput): string {
  return JSON.stringify({
    audience: input.audience,
    parent: { text: input.parentText },
    reply: input.reply,
  });
}

/**
 * Why a reading cannot be sent. Linq only accepts the listed screen and bubble
 * names, and a send with no text is not a message. Neither is a judgement about
 * wording.
 */
export type LinqEffectRefusal = 'unknown_effect' | 'empty_text';

export function linqEffectRefusals(
  decision: LinqEffectDecision,
  reply: string,
): LinqEffectRefusal[] {
  const refusals: LinqEffectRefusal[] = [];
  if (decision.effect !== null && !isLinqMessageEffect(decision.effect)) {
    refusals.push('unknown_effect');
  }
  if (decision.effect !== null && !reply.trim()) refusals.push('empty_text');
  return refusals;
}

export function createLinqEffectDecider(
  clientOrResolver: AgentClient | (() => AgentClient),
): LinqEffectDecider {
  return {
    async decide(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('linq-effect');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: linqEffectUserMessage(input),
          toolName: LINQ_EFFECT_TOOL,
          toolDescription: 'Return the iMessage effect to send with the reply, or null.',
          inputJsonSchema: LINQ_EFFECT_TOOL_SCHEMA,
          schema: outputSchema,
          maxTokens: LINQ_EFFECT_MAX_TOKENS,
        });
        const decision: LinqEffectDecision = { effect: value.effect };
        const refusals = linqEffectRefusals(decision, input.reply);
        if (refusals.length > 0) {
          console.warn({ refusals }, 'linq effect: reading unusable, reply goes plain');
          return null;
        }
        return decision;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq effect: read failed, reply goes plain',
        );
        return null;
      }
    },
  };
}

let shared: LinqEffectDecider | null = null;

export function sharedLinqEffectDecider(): LinqEffectDecider {
  shared ??= createLinqEffectDecider(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

export type LinqEffectOutcome =
  | { status: 'sent'; effect: LinqMessageEffect; providerMessageId: string }
  | { status: 'declined' }
  | {
      status: 'not_sent';
      reason: 'model_failed' | 'refused' | 'not_configured' | 'unreachable';
      code?: string;
      httpStatus?: number;
    };

/** Ask the model, then send the reply with the effect it chose. Never throws. */
export async function applyLinqEffect(input: {
  decider: LinqEffectDecider;
  chatId: string;
  text: string;
  replyToMessageId: string | null;
  read: LinqEffectInput;
  fetch?: typeof fetch;
}): Promise<LinqEffectOutcome> {
  const decision = await input.decider.decide(input.read);
  if (!decision) return { status: 'not_sent', reason: 'model_failed' };
  if (decision.effect === null) return { status: 'declined' };
  try {
    const sent = await sendLinqEffect({
      chatId: input.chatId,
      text: input.text,
      effect: decision.effect,
      replyTo: input.replyToMessageId ? { messageId: input.replyToMessageId } : undefined,
      fetch: input.fetch,
    });
    return { status: 'sent', effect: decision.effect, providerMessageId: sent.providerMessageId };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      console.warn({ reason: 'not_configured' }, 'linq effect: not sent');
      return { status: 'not_sent', reason: 'not_configured', code: err.code };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      console.warn({ code: err.code }, 'linq effect: unreachable, the reply still goes out');
      return { status: 'not_sent', reason: 'unreachable', code: err.code };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn({ code, httpStatus }, 'linq effect: refused, the reply still goes out');
    return { status: 'not_sent', reason: 'refused', code, httpStatus };
  }
}
