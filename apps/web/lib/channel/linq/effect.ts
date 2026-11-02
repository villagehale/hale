import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { sendLinqEffect } from '~/lib/channel/outbound-transport';
import { assertTurnLive } from '~/lib/channel/router/deadline';
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
} from './transport';

/**
 * VIL-473 — an iMessage screen or bubble effect on Hale's reply, when the model
 * says one fits.
 *
 * Behind `LINQ_EFFECTS_ENABLED`, exactly `true`, and only on a Preview deploy.
 * Production stays dark. The `linq-effect`
 * skill reads the parent's message and the reply Hale already wrote, and returns
 * the effect or none. Code never picks an effect and has no fallback one: a
 * failed or unusable read, or a provider that refused the effect, sends the
 * reply as a plain bubble. A send that may already have landed does not.
 *
 * Two facts sit in front of the model: no effect during the parent's quiet
 * hours, and at most one effect per conversation stretch — no repeat in this
 * chat within 24 hours, read from send history.
 */

export { linqEffectsEnabled };

/** One effect per chat per stretch. A later send in the same chat waits this out. */
export const LINQ_EFFECT_REPEAT_MS = 24 * 60 * 60 * 1000;

export type LinqEffectHold = 'quiet_hours' | 'recent_in_chat';

/**
 * Whether an effect may play, from the clock and this chat's send history.
 * A hold is named; the reply still goes out as a plain bubble.
 */
export function linqEffectHold(input: {
  now: Date;
  timeZone: string;
  lastEffectAt: Date | null;
}): LinqEffectHold | null {
  if (inProactiveQuietHours(input.now, input.timeZone)) return 'quiet_hours';
  if (
    input.lastEffectAt &&
    input.now.getTime() - input.lastEffectAt.getTime() < LINQ_EFFECT_REPEAT_MS
  ) {
    return 'recent_in_chat';
  }
  return null;
}

/** Latest `linq:effect` send in this chat, from the outbound ledger. */
export async function lastLinqEffectAt(database: Database, chatId: string): Promise<Date | null> {
  const [row] = await database
    .select({
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
      providerChatId: schema.channelMessages.providerChatId,
      direction: schema.channelMessages.direction,
      templateKey: schema.channelMessages.templateKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerChatId, chatId),
        eq(schema.channelMessages.templateKey, 'linq:effect'),
        eq(schema.channelMessages.direction, 'out'),
      ),
    )
    .orderBy(desc(schema.channelMessages.sentAt), desc(schema.channelMessages.createdAt))
    .limit(1);
  // The predicate above is the bound. A stand-in that returns some other row
  // must not count as this chat's last effect.
  if (
    !row ||
    row.providerChatId !== chatId ||
    row.direction !== 'out' ||
    row.templateKey !== 'linq:effect'
  ) {
    return null;
  }
  return row.sentAt ?? row.createdAt ?? null;
}

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
/**
 * `null` is its own arm. A `oneOf` of objects beside `type: ['object','null']`
 * rejects null, which is the decision on an ordinary reply, and `oneOf` itself
 * cannot be compiled into the grammar so the call would go out unconstrained.
 */
export const LINQ_EFFECT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    effect: {
      anyOf: [
        { type: 'null' },
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
      /**
       * The POST may already be on the phone: the wait expired, the connection
       * dropped, or Linq accepted and sent no message id. A second POST would
       * be a second copy of the reply.
       */
      status: 'uncertain';
      code: string;
      httpStatus?: number;
    }
  | {
      status: 'not_sent';
      reason: 'model_failed' | 'refused' | 'not_configured';
      code?: string;
      httpStatus?: number;
    };

/**
 * Provider outcomes that cannot prove the effect did not go out. A named
 * refusal (a 4xx Linq answered with) is not in this set.
 */
const AMBIGUOUS_EFFECT_SEND = new Set(['timeout', 'network', 'missing_message_id']);

/**
 * Ask the model, then send the reply with the effect it chose.
 *
 * Throws `DeadlineError` (`turn_timeout`) when this turn's deadline has already
 * fired, so a decision that lands after the drain has moved on cannot send.
 * Every other failure is a result.
 */
export async function applyLinqEffect(input: {
  decider: LinqEffectDecider;
  chatId: string;
  text: string;
  replyToMessageId: string | null;
  read: LinqEffectInput;
  fetch?: typeof fetch;
}): Promise<LinqEffectOutcome> {
  const decision = await input.decider.decide(input.read);
  // After the model call, before any POST. A late decision must not become a
  // send, and must not become the plain-text fallback either: the caller sees
  // the deadline and stops.
  assertTurnLive();
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
    // Anything that is not a Linq refusal may already be on the phone. A plain
    // second POST would be a second copy of the reply.
    if (!(err instanceof LinqSendError)) {
      console.warn({ code: 'unknown' }, 'linq effect: delivery uncertain; not sending again');
      return { status: 'uncertain', code: 'unknown' };
    }
    if (err.code === 'not_configured') {
      console.warn({ reason: 'not_configured' }, 'linq effect: not sent');
      return { status: 'not_sent', reason: 'not_configured', code: err.code };
    }
    if (AMBIGUOUS_EFFECT_SEND.has(err.code)) {
      console.warn({ code: err.code }, 'linq effect: delivery uncertain; not sending again');
      return { status: 'uncertain', code: err.code, httpStatus: err.httpStatus };
    }
    console.warn(
      { code: err.code, httpStatus: err.httpStatus },
      'linq effect: refused, the reply still goes out',
    );
    return { status: 'not_sent', reason: 'refused', code: err.code, httpStatus: err.httpStatus };
  }
}
