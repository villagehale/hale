import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { knownTimezone } from '~/lib/channel/household-timezone';
import { sendLinqEffect } from '~/lib/channel/outbound-transport';
import { assertTurnLive } from '~/lib/channel/router/deadline';
import { loadCronSkill } from '~/lib/cron/skill';
import { formatSnapshotLocalNow } from '~/lib/format/datetime';
import { LINQ_EFFECT_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
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
 * Behind `LINQ_EFFECTS_ENABLED`, exactly `true` (trimmed). Default off.
 * Production may light it the same way as any other environment. The `linq-effect`
 * skill reads the parent's message and the reply Hale already wrote, and returns
 * the effect or none. Code never picks an effect and has no fallback one: a
 * failed or unusable read, or a provider that refused the effect, sends the
 * reply as a plain bubble. A send that may already have landed does not: its row
 * is named and ops is paged with it (router/route.ts sendReply).
 *
 * Code holds no clock window and no per-chat quota (decision 2026-11-04: the
 * model decides when an effect fits). It hands the model two facts instead:
 * the parent's wall clock, and how long ago this chat last played an effect.
 */

export { linqEffectsEnabled };

/** The template key on an effect reply's outbound row: how the next read finds this
 * chat's last effect. */
export const LINQ_EFFECT_TEMPLATE_KEY = 'linq:effect';

/** The error code on an effect reply's row when nobody saw Linq take the POST. Nothing
 * settles it on its own: ops is paged with the row. */
export const LINQ_EFFECT_DELIVERY_UNKNOWN = 'delivery_unknown';

/**
 * Why a reply was never offered to the effect read, by the lane's own facts about it:
 * a medical answer, or a safety moment (someone hurt, ill, in danger or in crisis).
 * Each is logged by name, apart from a reply nothing wired a read for.
 */
export type LinqEffectWithheld = 'medical_reply' | 'safety_reply';

/** Latest effect reply in this chat, from the outbound ledger. */
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
        eq(schema.channelMessages.templateKey, LINQ_EFFECT_TEMPLATE_KEY),
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
    row.templateKey !== LINQ_EFFECT_TEMPLATE_KEY
  ) {
    return null;
  }
  return row.sentAt ?? row.createdAt ?? null;
}

/**
 * The parent's stored zone, or null. No default zone stands in, and neither does the
 * column default (UTC, never set): a parent whose zone Hale does not know is shown no
 * wall clock rather than another city's.
 */
export async function parentStoredTimeZone(
  database: Database,
  parentUserId: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return knownTimezone(rows.find((row) => row.id === parentUserId)?.timezone);
}

const HOUR_MS = 60 * 60 * 1000;

/** The two facts the model reads beside the bodies. */
export function linqEffectClockFacts(input: {
  now: Date;
  timeZone: string | null;
  lastEffectAt: Date | null;
}): Pick<LinqEffectInput, 'parentLocalTime' | 'lastEffectHoursAgo'> {
  return {
    parentLocalTime: input.timeZone ? formatSnapshotLocalNow(input.now, input.timeZone) : null,
    lastEffectHoursAgo: input.lastEffectAt
      ? Math.max(0, Math.floor((input.now.getTime() - input.lastEffectAt.getTime()) / HOUR_MS))
      : null,
  };
}

export interface LinqEffectInput {
  audience: 'direct' | 'group';
  parentText: string;
  reply: string;
  /** The parent's wall clock, already in their zone. Null: no zone is stored. */
  parentLocalTime: string | null;
  /** Whole hours since this chat last played an effect. Null: it never has. */
  lastEffectHoursAgo: number | null;
}

export interface LinqEffectDecision {
  effect: LinqMessageEffect | null;
}

/** Why the read gave no decision: it ran out of time, or it failed or came back
 * unusable. The reply goes out plain either way. */
export interface LinqEffectReadFailure {
  failed: 'model_timeout' | 'model_failed';
}

export interface LinqEffectDecider {
  decide(input: LinqEffectInput): Promise<LinqEffectDecision | LinqEffectReadFailure>;
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
    parentLocalTime: input.parentLocalTime,
    lastEffectHoursAgo: input.lastEffectHoursAgo,
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
          return { failed: 'model_failed' };
        }
        return decision;
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) {
          console.warn({ err: err.name }, 'linq effect: read timed out, reply goes plain');
          return { failed: 'model_timeout' };
        }
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq effect: read failed, reply goes plain',
        );
        return { failed: 'model_failed' };
      }
    },
  };
}

let shared: LinqEffectDecider | null = null;

export function sharedLinqEffectDecider(): LinqEffectDecider {
  shared ??= createLinqEffectDecider(() =>
    budgetedAnthropic(LINQ_EFFECT_CLIENT_OPTIONS, { stage: 'reply_intent' }),
  );
  return shared;
}

export type LinqEffectOutcome =
  | { status: 'sent'; effect: LinqMessageEffect; providerMessageId: string }
  | { status: 'declined' }
  | {
      /**
       * The POST may already be on the phone: the wait expired, Linq or a
       * gateway in front of it answered with a 5xx, or Linq accepted and sent no
       * message id. A second POST would be a second copy of the reply.
       */
      status: 'uncertain';
      code: string;
      httpStatus?: number;
    }
  | {
      status: 'not_sent';
      reason: LinqEffectReadFailure['failed'] | 'refused' | 'unreachable' | 'not_configured';
      code?: string;
      httpStatus?: number;
    };

/**
 * Provider outcomes that cannot prove the effect did not go out. A named
 * refusal (a 4xx Linq answered with) is not in this set, and neither is
 * `network` (see below).
 */
const AMBIGUOUS_EFFECT_SEND = new Set(['timeout', 'missing_message_id']);

/** Any 5xx: Linq, or a gateway in front of it, failed somewhere after the POST arrived,
 * and nothing says the message was not sent before it did. Read by status, since the
 * body can carry any code. */
function ambiguousEffectHttp(httpStatus: number): boolean {
  return httpStatus >= 500 && httpStatus <= 599;
}

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
  /** VIL-475 — the handle the plain send would mention, or undefined. Read only once
   * an effect is chosen, so a decline costs no mention read. */
  mentionFor: () => Promise<string | undefined>;
  /** The caller's identity for this send (Linq's idempotency key), when it owns one.
   * Absent: the effect is its own send. */
  sendKey?: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectOutcome> {
  const decision = await input.decider.decide(input.read);
  // After the model call, before any POST. A late decision must not become a
  // send, and must not become the plain-text fallback either: the caller sees
  // the deadline and stops.
  assertTurnLive();
  if ('failed' in decision) return { status: 'not_sent', reason: decision.failed };
  if (decision.effect === null) return { status: 'declined' };
  const mention = await input.mentionFor();
  assertTurnLive();
  try {
    const sent = await sendLinqEffect({
      chatId: input.chatId,
      text: input.text,
      effect: decision.effect,
      replyTo: input.replyToMessageId ? { messageId: input.replyToMessageId } : undefined,
      ...(mention ? { mention } : {}),
      ...(input.sendKey ? { sendKey: input.sendKey } : {}),
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
    // A fetch that threw before Linq answered most often never reached it, and a
    // lost reply is worse than a second copy: the reply goes plain, as a plain
    // send's own network failure is sent again (send, then claim: turn-ledger.ts).
    if (err.code === 'network') {
      console.warn({ code: err.code }, 'linq effect: unreachable, the reply still goes out');
      return { status: 'not_sent', reason: 'unreachable', code: err.code };
    }
    if (AMBIGUOUS_EFFECT_SEND.has(err.code) || ambiguousEffectHttp(err.httpStatus)) {
      console.warn(
        { code: err.code, httpStatus: err.httpStatus },
        'linq effect: delivery uncertain; not sending again',
      );
      return { status: 'uncertain', code: err.code, httpStatus: err.httpStatus };
    }
    console.warn(
      { code: err.code, httpStatus: err.httpStatus },
      'linq effect: refused, the reply still goes out',
    );
    return { status: 'not_sent', reason: 'refused', code: err.code, httpStatus: err.httpStatus };
  }
}
