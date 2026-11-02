import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinqParts } from '~/lib/channel/outbound-transport';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type AppClipPayTier,
  isSandboxCheckoutUrl,
  sandboxPaymentBlocked,
} from './app-clip-sandbox';
import { linqAppClipPayEnabled } from './config';
import { LinqSendError, createLinqSandboxPaymentRequest } from './transport';

/**
 * VIL-481 — an Apple Pay App Clip card for Plus or Family, Preview only.
 *
 * Hale's AI decides whether this turn is a pay ask and writes the checkout's
 * one line. This module holds no parent-facing sentence. A model that does not
 * answer, declines, or writes a line the card cannot carry (empty, a price, a
 * URL) sends nothing: no payment request and no message.
 *
 * The request is sandbox (`livemode: false`, a host that cannot resolve). A
 * Linq key or a live Stripe key refuses the whole send. The card is one
 * `app_clip` part. A later `4005` sends that same sandbox URL as a `link`
 * part and nothing else.
 *
 * https://docs.linqapp.com/channel/imessage/guides/payments/sending-payment-links/
 */

const DESCRIPTION_MAX = 240;
const PRICE = /[$€£]|\b(?:cad|usd|dollars?|cents)\b|\b\d+(?:[.,]\d{2})\b/i;
const URL_IN_COPY = /https?:\/\/|www\./i;

export const APP_CLIP_PAY_TEMPLATE = 'linq:app_clip_pay';
export const APP_CLIP_PAY_LINK_TEMPLATE = 'linq:app_clip_pay_link';

export const APP_CLIP_PAY_TOOL = 'app_clip_pay';
export const APP_CLIP_PAY_MAX_TOKENS = 400;
export const APP_CLIP_PAY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    offer: { type: 'boolean' },
    tier: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
  },
  required: ['offer', 'tier', 'description'],
} as const;

const outputSchema = z.object({
  offer: z.boolean(),
  tier: z.enum(['plus', 'family']).nullable(),
  description: z.string().nullable(),
});

export interface AppClipPayRead {
  audience: 'direct' | 'group';
  planTier: 'free' | 'plus' | 'family';
  parentText: string;
}

export interface AppClipPayDecision {
  offer: boolean;
  tier: AppClipPayTier | null;
  description: string | null;
}

export interface AppClipPayDecider {
  /** Null: the read failed. Nothing is sent. */
  decide(input: AppClipPayRead): Promise<AppClipPayDecision | null>;
}

/** The user-turn payload. Shared with any cached replay of this request. */
export function appClipPayUserMessage(input: AppClipPayRead): string {
  return JSON.stringify({
    audience: input.audience,
    planTier: input.planTier,
    parentText: input.parentText,
  });
}

export type AppClipPayCopyRefusal = 'empty' | 'too_long' | 'price' | 'url' | 'not_one_line';

/** Why a model-written line cannot go on the checkout. Empty means it can. */
export function appClipPayCopyRefusals(description: string): AppClipPayCopyRefusal[] {
  const line = description.trim();
  const refusals: AppClipPayCopyRefusal[] = [];
  if (line === '') refusals.push('empty');
  if (line.length > DESCRIPTION_MAX) refusals.push('too_long');
  if (PRICE.test(line)) refusals.push('price');
  if (URL_IN_COPY.test(line)) refusals.push('url');
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
            'Decide whether to offer Apple Pay, and write the checkout line. Offer false sends nothing.',
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
      status: 'fallback';
      cardProviderMessageId: string;
      checkoutUrl: string;
      linkProviderMessageId: string;
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
  checkoutUrl: string;
  templateKey: string;
  audit: 'linq_app_clip_pay' | 'linq_app_clip_pay_link';
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
      // The sandbox checkout, so a 4005 can send the same URL. Not a sentence.
      body: input.checkoutUrl,
      status: acceptedStatus('imessage'),
      sentAt: input.now ?? new Date(),
    })
    .returning({ id: schema.channelMessages.id });
  if (row?.id) {
    const audit = {
      familyId: input.familyId,
      actor: input.parentUserId,
      targetTable: 'channel_messages' as const,
      targetId: row.id,
    };
    if (input.audit === 'linq_app_clip_pay') {
      await input.database.insert(schema.auditLog).values({
        ...audit,
        actionTaken: 'linq_app_clip_pay',
      });
    } else {
      await input.database.insert(schema.auditLog).values({
        ...audit,
        actionTaken: 'linq_app_clip_pay_link',
      });
    }
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
    checkoutUrl: input.checkoutUrl,
    templateKey: input.part === 'app_clip' ? APP_CLIP_PAY_TEMPLATE : APP_CLIP_PAY_LINK_TEMPLATE,
    audit: input.part === 'app_clip' ? 'linq_app_clip_pay' : 'linq_app_clip_pay_link',
    now: input.now,
  });
  return { providerMessageId: sent.providerMessageId, ledger };
}

/**
 * Ask the model, then send one App Clip card when it wrote a line the card can
 * carry. `unreachable` sends the card and then the link, the same pair a 4005
 * receipt produces. Never throws. Never sends a sentence this module wrote.
 */
export async function deliverAppClipPay(input: {
  channel: string;
  chatId: string | null;
  isGroup?: boolean;
  read: AppClipPayRead;
  decider: AppClipPayDecider;
  /** After the card is accepted, also send the link fallback (async 4005). */
  unreachable?: boolean;
  fetch?: typeof fetch;
  sendParts?: SendParts;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<AppClipPayOutcome> {
  if (!linqAppClipPayEnabled()) return { status: 'not_sent', reason: 'dark' };
  const blocked = sandboxPaymentBlocked();
  if (blocked) return { status: 'not_sent', reason: blocked };
  if (input.channel !== 'imessage') return { status: 'not_sent', reason: 'not_imessage' };
  if (!input.chatId) return { status: 'not_sent', reason: 'no_chat' };
  if (input.isGroup || input.read.audience === 'group') {
    return { status: 'not_sent', reason: 'group_chat' };
  }

  const decision = await input.decider.decide(input.read);
  if (!decision) {
    console.info('app clip pay: unwritten, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }
  if (!decision.offer) return { status: 'not_sent', reason: 'declined' };
  const description = decision.description?.trim() ?? '';
  const tier = decision.tier;
  if (!tier || appClipPayCopyRefusals(description).length > 0) {
    console.info('app clip pay: line unusable, nothing sent');
    return { status: 'not_sent', reason: 'unwritten' };
  }

  let created: { id: string; checkoutUrl: string };
  try {
    created = await createLinqSandboxPaymentRequest({
      tier,
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
      chatId: input.chatId,
      checkoutUrl: created.checkoutUrl,
      part: 'app_clip',
      fetch: input.fetch,
      sendParts: input.sendParts,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    if (!input.unreachable) {
      return {
        status: 'card',
        providerMessageId: card.providerMessageId,
        checkoutUrl: created.checkoutUrl,
        ledger: card.ledger,
      };
    }
    const link = await sendCheckoutPart({
      chatId: input.chatId,
      checkoutUrl: created.checkoutUrl,
      part: 'link',
      fetch: input.fetch,
      sendParts: input.sendParts,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    return {
      status: 'fallback',
      cardProviderMessageId: card.providerMessageId,
      linkProviderMessageId: link.providerMessageId,
      checkoutUrl: created.checkoutUrl,
      ledger: link.ledger,
    };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === '4005') {
      try {
        const link = await sendCheckoutPart({
          chatId: input.chatId,
          checkoutUrl: created.checkoutUrl,
          part: 'link',
          fetch: input.fetch,
          sendParts: input.sendParts,
          database: input.database,
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          now: input.now,
        });
        return {
          status: 'fallback',
          cardProviderMessageId: '',
          linkProviderMessageId: link.providerMessageId,
          checkoutUrl: created.checkoutUrl,
          ledger: link.ledger,
        };
      } catch (linkErr) {
        return { status: 'not_sent', reason: sendFailure(linkErr) };
      }
    }
    return { status: 'not_sent', reason: sendFailure(err) };
  }
}

/**
 * A `message.failed` whose code is 4005, for a card this module already sent.
 * Sends the same sandbox URL as a link part. Any other row, code, or URL sends
 * nothing.
 */
export async function fallbackAppClipPayOn4005(
  database: Database,
  providerMessageId: string,
  deps: { fetch?: typeof fetch; sendParts?: SendParts; now?: Date } = {},
): Promise<
  | { status: 'link'; providerMessageId: string; ledger: 'recorded' | 'not_recorded' }
  | { status: 'not_sent'; reason: AppClipPayNotSentReason }
> {
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
  try {
    const link = await sendCheckoutPart({
      chatId: row.chatId,
      checkoutUrl: row.body,
      part: 'link',
      fetch: deps.fetch,
      sendParts: deps.sendParts,
      database,
      familyId: row.familyId,
      parentUserId: row.parentUserId,
      now: deps.now,
    });
    return { status: 'link', providerMessageId: link.providerMessageId, ledger: link.ledger };
  } catch (err) {
    return { status: 'not_sent', reason: sendFailure(err) };
  }
}
