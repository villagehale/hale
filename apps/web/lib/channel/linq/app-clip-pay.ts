import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  createLinqSandboxPaymentRequest,
  sendLinqParts,
} from '~/lib/channel/outbound-transport';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type AppClipPayTier,
  isSandboxCheckoutUrl,
  sandboxPaymentBlocked,
} from './app-clip-sandbox';
import { linqAppClipPayEnabled } from './config';
import { LinqSendError } from './transport';

/**
 * VIL-481 — an Apple Pay App Clip card for Plus or Family, Preview only.
 *
 * Hale's AI decides whether this turn is a pay ask and writes the checkout's
 * one line. This module holds no parent-facing sentence. A model that does not
 * answer, declines, or writes a line the card cannot carry (empty, too long,
 * or more than one line) sends nothing: no payment request and no message.
 * Price and URL are the skill's job, and a judge's, not a word list here.
 *
 * The request is sandbox (`livemode: false`, a host that cannot resolve). A
 * Linq key or a live Stripe key refuses the whole send. The card is one
 * `app_clip` part. A later `4005` sends nothing unless the model writes a
 * fresh line, in which case that bubble and the link go out together. A bare
 * link is never sent. The card and the link are never both sent in one turn.
 *
 * https://docs.linqapp.com/channel/imessage/guides/payments/sending-payment-links/
 */

const DESCRIPTION_MAX = 240;

export const APP_CLIP_PAY_TEMPLATE = 'linq:app_clip_pay';
export const APP_CLIP_PAY_LINE_TEMPLATE = 'linq:app_clip_pay_line';
export const APP_CLIP_PAY_LINK_TEMPLATE = 'linq:app_clip_pay_link';

export const APP_CLIP_PAY_TOOL = 'app_clip_pay';
export const APP_CLIP_PAY_MAX_TOKENS = 400;
export const APP_CLIP_PAY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    offer: { type: 'boolean' },
    tier: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    line: { type: ['string', 'null'] },
  },
  required: ['offer', 'tier', 'description', 'line'],
} as const;

const outputSchema = z.object({
  offer: z.boolean(),
  tier: z.enum(['plus', 'family']).nullable(),
  description: z.string().nullable(),
  line: z.string().nullable(),
});

export type AppClipPayMoment = 'card' | 'fallback';
export type AppClipPayPrior = 'no' | 'no_tap';

export interface AppClipPayRead {
  audience: 'direct' | 'group';
  planTier: 'free' | 'plus' | 'family';
  parentText: string;
  /** `card` decides the App Clip. `fallback` is a fresh write after a 4005. */
  moment?: AppClipPayMoment;
  /** Children in the household. Null when this turn was not told. */
  childCount?: number | null;
  /** Whether a co-parent is in the household. Null when this turn was not told. */
  coparent?: boolean | null;
  /** A no, or a card they did not open. Null when neither has happened. */
  prior?: AppClipPayPrior | null;
}

export interface AppClipPayDecision {
  offer: boolean;
  tier: AppClipPayTier | null;
  description: string | null;
  /** Thread bubble. Used only on `moment: 'fallback'`. Null sends nothing. */
  line: string | null;
}

export interface AppClipPayDecider {
  /** Null: the read failed. Nothing is sent. */
  decide(input: AppClipPayRead): Promise<AppClipPayDecision | null>;
}

/** The user-turn payload. Shared with any cached replay of this request. */
export function appClipPayUserMessage(input: AppClipPayRead): string {
  return JSON.stringify({
    moment: input.moment ?? 'card',
    audience: input.audience,
    planTier: input.planTier,
    parentText: input.parentText,
    childCount: input.childCount ?? null,
    coparent: input.coparent ?? null,
    prior: input.prior ?? null,
  });
}

export type AppClipPayCopyRefusal = 'empty' | 'too_long' | 'not_one_line';

/**
 * Structural only: empty, over 240 characters, or more than one line.
 * A price, a URL, or a billing period is for the skill and the judge.
 */
export function appClipPayCopyRefusals(description: string): AppClipPayCopyRefusal[] {
  const line = description.trim();
  const refusals: AppClipPayCopyRefusal[] = [];
  if (line === '') refusals.push('empty');
  if (line.length > DESCRIPTION_MAX) refusals.push('too_long');
  if (/[\r\n]/.test(description)) refusals.push('not_one_line');
  return refusals;
}

export function createAppClipPayDecider(
  clientOrResolver: AgentClient | (() => AgentClient),
): AppClipPayDecider {
  return {
    async decide(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('app-clip-pay');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: appClipPayUserMessage(input),
          toolName: APP_CLIP_PAY_TOOL,
          toolDescription:
            'Decide the Apple Pay card, or on a fallback write one fresh line. A null line sends nothing. Do not guess a plan.',
          inputJsonSchema: APP_CLIP_PAY_TOOL_SCHEMA,
          schema: outputSchema,
          maxTokens: APP_CLIP_PAY_MAX_TOKENS,
        });
        return value;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'app clip pay: read failed, nothing sent',
        );
        return null;
      }
    },
  };
}

let shared: AppClipPayDecider | null = null;

export function sharedAppClipPayDecider(): AppClipPayDecider {
  shared ??= createAppClipPayDecider(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

export type AppClipPayNotSentReason =
  | 'dark'
  | 'live_key'
  | 'not_preview'
  | 'not_imessage'
  | 'no_chat'
  | 'group_chat'
  | 'declined'
  | 'unwritten'
  | 'not_configured'
  | 'refused'
  | 'unreachable'
  | 'not_app_clip'
  | 'no_url'
  | 'not_4005';

export type AppClipPayOutcome =
  | {
      status: 'card';
      providerMessageId: string;
      checkoutUrl: string;
      ledger: 'recorded' | 'not_recorded';
    }
  | {
      /** The model's line and the link. The card was not sent in this turn. */
      status: 'link';
      lineProviderMessageId: string;
      linkProviderMessageId: string;
      checkoutUrl: string;
      ledger: 'recorded' | 'not_recorded';
    }
  | { status: 'not_sent'; reason: AppClipPayNotSentReason };

type SendParts = typeof sendLinqParts;

function sendFailure(err: unknown): AppClipPayNotSentReason {
  if (!(err instanceof LinqSendError)) return 'refused';
  if (err.code === 'not_configured' || err.code === 'preview_capture') return 'not_configured';
  if (err.code === 'not_preview' || err.code === 'live_key' || err.code === 'live_payment') {
    return err.code === 'not_preview' ? 'not_preview' : 'live_key';
  }
  if (err.code === 'timeout' || err.code === 'network') return 'unreachable';
  return 'refused';
}

async function recordSend(input: {
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  chatId: string;
  providerMessageId: string;
  /** Checkout URL, or the model's thread line. Never a sentence this module wrote. */
  body: string;
  templateKey: string;
  /** The link has no trail verb. The card and the model's bubble do. */
  audit: 'linq_app_clip_pay' | 'sms_reply_sent' | null;
  now?: Date;
}): Promise<'recorded' | 'not_recorded'> {
  if (!input.database || !input.familyId || !input.parentUserId) {
    console.info({ templateKey: input.templateKey }, 'app clip pay: ledger not_recorded');
    return 'not_recorded';
  }
  const [row] = await input.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      providerMessageId: input.providerMessageId,
      providerChatId: input.chatId,
      body: input.body,
      status: acceptedStatus('imessage'),
      sentAt: input.now ?? new Date(),
    })
    .returning({ id: schema.channelMessages.id });
  if (row?.id && input.audit === 'linq_app_clip_pay') {
    await input.database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      targetTable: 'channel_messages',
      targetId: row.id,
      actionTaken: 'linq_app_clip_pay',
    });
  } else if (row?.id && input.audit === 'sms_reply_sent') {
    await input.database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      targetTable: 'channel_messages',
      targetId: row.id,
      actionTaken: 'sms_reply_sent',
    });
  }
  return 'recorded';
}

async function sendCheckoutPart(input: {
  chatId: string;
  checkoutUrl: string;
  part: 'app_clip' | 'link';
  fetch?: typeof fetch;
  sendParts?: SendParts;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<{ providerMessageId: string; ledger: 'recorded' | 'not_recorded' }> {
  if (!isSandboxCheckoutUrl(input.checkoutUrl)) {
    throw new LinqSendError('live_payment', 400, true);
  }
  const message = {
    chatId: input.chatId,
    parts: [{ type: input.part, value: input.checkoutUrl }] as const,
    fetch: input.fetch,
  };
  const sent = input.sendParts ? await input.sendParts(message) : await sendLinqParts(message);
  const ledger = await recordSend({
    database: input.database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    providerMessageId: sent.providerMessageId,
    body: input.checkoutUrl,
    templateKey: input.part === 'app_clip' ? APP_CLIP_PAY_TEMPLATE : APP_CLIP_PAY_LINK_TEMPLATE,
    // The link rides with the model's bubble, which carries the trail row.
    audit: input.part === 'app_clip' ? 'linq_app_clip_pay' : null,
    now: input.now,
  });
  return { providerMessageId: sent.providerMessageId, ledger };
}

/** The model's fresh line, or null when it cannot be sent. No word list. */
function freshLine(decision: AppClipPayDecision | null): string | null {
  const line = decision?.line?.trim() ?? '';
  if (!decision || appClipPayCopyRefusals(line).length > 0) return null;
  return line;
}

/**
 * Text bubble, then the link. Either both, or neither. A link is never the
 * only part, and this never sends the card.
 */
async function sendLineAndLink(input: {
  chatId: string;
  checkoutUrl: string;
  line: string;
  fetch?: typeof fetch;
  sendParts?: SendParts;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<
  | {
      status: 'link';
      lineProviderMessageId: string;
      linkProviderMessageId: string;
      checkoutUrl: string;
      ledger: 'recorded' | 'not_recorded';
    }
  | { status: 'not_sent'; reason: AppClipPayNotSentReason }
> {
  if (!isSandboxCheckoutUrl(input.checkoutUrl)) {
    return { status: 'not_sent', reason: 'no_url' };
  }
  const send = input.sendParts ?? sendLinqParts;
  let text: { providerMessageId: string };
  try {
    text = await send({
      chatId: input.chatId,
      parts: [{ type: 'text', value: input.line }],
      fetch: input.fetch,
    });
  } catch (err) {
    return { status: 'not_sent', reason: sendFailure(err) };
  }
  const ledger = await recordSend({
    database: input.database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    providerMessageId: text.providerMessageId,
    body: input.line,
    templateKey: APP_CLIP_PAY_LINE_TEMPLATE,
    audit: 'sms_reply_sent',
    now: input.now,
  });
  try {
    const link = await sendCheckoutPart({
      chatId: input.chatId,
      checkoutUrl: input.checkoutUrl,
      part: 'link',
      fetch: input.fetch,
      sendParts: input.sendParts,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    return {
      status: 'link',
      lineProviderMessageId: text.providerMessageId,
      linkProviderMessageId: link.providerMessageId,
      checkoutUrl: input.checkoutUrl,
      ledger,
    };
  } catch (err) {
    console.warn({ reason: sendFailure(err) }, 'app clip pay: link did not follow the line');
    return { status: 'not_sent', reason: sendFailure(err) };
  }
}

function gate(input: {
  channel: string;
  chatId: string | null;
  isGroup?: boolean;
  read: AppClipPayRead;
}): AppClipPayNotSentReason | null {
  if (!linqAppClipPayEnabled()) return 'dark';
  const blocked = sandboxPaymentBlocked();
  if (blocked) return blocked;
  if (input.channel !== 'imessage') return 'not_imessage';
  if (!input.chatId) return 'no_chat';
  if (input.isGroup || input.read.audience === 'group') return 'group_chat';
  return null;
}

/**
 * Ask the model, then send one App Clip card when it named a plan and wrote a
 * checkout line. One ask. A synchronous 4005 does not also send the link: the
 * card did not land, and a bare link is not a substitute. Never throws.
 */
export async function deliverAppClipPay(input: {
  channel: string;
  chatId: string | null;
  isGroup?: boolean;
  read: AppClipPayRead;
  decider: AppClipPayDecider;
  fetch?: typeof fetch;
  sendParts?: SendParts;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<AppClipPayOutcome> {
  const closed = gate(input);
  if (closed) return { status: 'not_sent', reason: closed };
  const chatId = input.chatId as string;

  const decision = await input.decider.decide({ ...input.read, moment: 'card' });
  if (!decision) {
    console.info('app clip pay: unwritten, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }
  if (!decision.offer) return { status: 'not_sent', reason: 'declined' };
  const description = decision.description?.trim() ?? '';
  // No silent Plus. A missing tier is the model declining to choose.
  if (!decision.tier || appClipPayCopyRefusals(description).length > 0) {
    console.info('app clip pay: line unusable, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }

  let created: { id: string; checkoutUrl: string };
  try {
    created = await createLinqSandboxPaymentRequest({
      tier: decision.tier,
      description,
      familyId: input.familyId,
      fetch: input.fetch,
    });
  } catch (err) {
    const reason = sendFailure(err);
    console.warn({ reason }, 'app clip pay: sandbox request refused, nothing sent');
    return { status: 'not_sent', reason };
  }

  try {
    const card = await sendCheckoutPart({
      chatId,
      checkoutUrl: created.checkoutUrl,
      part: 'app_clip',
      fetch: input.fetch,
      sendParts: input.sendParts,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    return {
      status: 'card',
      providerMessageId: card.providerMessageId,
      checkoutUrl: created.checkoutUrl,
      ledger: card.ledger,
    };
  } catch (err) {
    if (!(err instanceof LinqSendError) || err.code !== '4005') {
      return { status: 'not_sent', reason: sendFailure(err) };
    }
    // The card did not land. This turn is the line and the link, or nothing.
    const again = await input.decider.decide({ ...input.read, moment: 'fallback' });
    const line = freshLine(again);
    if (!line) {
      console.info('app clip pay: 4005, no fresh line, nothing sent');
      return { status: 'not_sent', reason: 'unwritten' };
    }
    return sendLineAndLink({
      chatId,
      checkoutUrl: created.checkoutUrl,
      line,
      fetch: input.fetch,
      sendParts: input.sendParts,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
  }
}

/**
 * The 4005 turn, by itself. One fresh model write. A line goes out with the
 * link and the card does not. No line sends nothing, including no bare link.
 */
export async function deliverAppClipPayFallback(input: {
  channel: string;
  chatId: string | null;
  isGroup?: boolean;
  read: AppClipPayRead;
  decider: AppClipPayDecider;
  fetch?: typeof fetch;
  sendParts?: SendParts;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<AppClipPayOutcome> {
  const closed = gate(input);
  if (closed) return { status: 'not_sent', reason: closed };
  const chatId = input.chatId as string;

  const decision = await input.decider.decide({ ...input.read, moment: 'fallback' });
  const line = freshLine(decision);
  const description = decision?.description?.trim() ?? '';
  if (!decision || !line || !decision.tier || appClipPayCopyRefusals(description).length > 0) {
    console.info('app clip pay: 4005, no fresh line, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }

  let created: { checkoutUrl: string };
  try {
    created = await createLinqSandboxPaymentRequest({
      tier: decision.tier,
      description,
      familyId: input.familyId,
      fetch: input.fetch,
    });
  } catch (err) {
    return { status: 'not_sent', reason: sendFailure(err) };
  }
  return sendLineAndLink({
    chatId,
    checkoutUrl: created.checkoutUrl,
    line,
    fetch: input.fetch,
    sendParts: input.sendParts,
    database: input.database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
}

/**
 * A `message.failed` 4005 for a card this module already sent. Asks the model
 * for a fresh line. That line and the existing sandbox link go out together,
 * or nothing does. Never a bare link.
 */
export async function fallbackAppClipPayOn4005(
  database: Database,
  providerMessageId: string,
  deps: {
    fetch?: typeof fetch;
    sendParts?: SendParts;
    now?: Date;
    decider?: AppClipPayDecider;
  } = {},
): Promise<AppClipPayOutcome> {
  const [row] = await database
    .select({
      templateKey: schema.channelMessages.templateKey,
      body: schema.channelMessages.body,
      chatId: schema.channelMessages.providerChatId,
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      channel: schema.channelMessages.channel,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, providerMessageId))
    .limit(1);
  if (!row || row.templateKey !== APP_CLIP_PAY_TEMPLATE) {
    return { status: 'not_sent', reason: 'not_app_clip' };
  }
  if (!linqAppClipPayEnabled()) return { status: 'not_sent', reason: 'dark' };
  const blocked = sandboxPaymentBlocked();
  if (blocked) return { status: 'not_sent', reason: blocked };
  if (row.channel !== 'imessage' || !row.chatId) {
    return { status: 'not_sent', reason: 'no_chat' };
  }
  if (!row.body || !isSandboxCheckoutUrl(row.body)) {
    return { status: 'not_sent', reason: 'no_url' };
  }

  const [family] = await database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, row.familyId))
    .limit(1);
  const [inbound] = await database
    .select({ body: schema.channelMessages.body })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerChatId, row.chatId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  const kids = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(eq(schema.children.familyId, row.familyId));
  const adults = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, row.familyId));
  const planTier =
    family?.planTier === 'plus' || family?.planTier === 'family' ? family.planTier : 'free';

  const decision = await (deps.decider ?? sharedAppClipPayDecider()).decide({
    moment: 'fallback',
    audience: 'direct',
    planTier,
    parentText: inbound?.body ?? '',
    childCount: kids.length,
    coparent: adults.some((member) => member.role === 'co_parent'),
    prior: null,
  });
  const line = freshLine(decision);
  if (!line) {
    console.info('app clip pay: 4005, no fresh line, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }
  return sendLineAndLink({
    chatId: row.chatId,
    checkoutUrl: row.body,
    line,
    fetch: deps.fetch,
    sendParts: deps.sendParts,
    database,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    now: deps.now,
  });
}
