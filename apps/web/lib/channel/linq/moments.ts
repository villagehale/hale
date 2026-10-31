import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { InboundMediaKind } from '~/lib/channel/inbound-media';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { parentTimeZoneForOffer } from '~/lib/integrations/email-alert-offer';
import {
  type LinqEffectDecider,
  applyLinqEffect,
  lastLinqEffectAt,
  linqEffectHold,
  linqEffectsEnabled,
} from './effect';
import { type LinqStickerDecider, applyLinqSticker, linqStickersEnabled } from './sticker';
import { applyLinqTapback } from './tapback';

/**
 * The product moment on an iMessage reply: a tapback instead of a throwaway
 * ack, or (VIL-472, flag `LINQ_STICKERS_ENABLED`) a sticker the model chose,
 * peeled onto the parent's message, or (VIL-473, flag `LINQ_EFFECTS_ENABLED`) the
 * reply sent with an iMessage effect the model chose. At most one moment per reply:
 * a peeled sticker means the reply goes plain. A miss falls through and the text still
 * goes out. SMS and email never call Linq from here. A year-find poll is not a
 * reply moment.
 */

export type LinqMoment =
  | { handled: false }
  | { handled: true; channelMessageId: string; threadBody: string | null };

export async function considerLinqReply(
  database: Database,
  args: {
    route: ReplyRoute;
    inboundBody: string;
    outboundBody: string;
    templateKey: string | null;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
    /** What the sticker read needs. Absent: no sticker is considered, and that is logged
     * when the flag is on. */
    sticker?: {
      decider: LinqStickerDecider;
      audience: 'direct' | 'group';
      parentAttachments: readonly InboundMediaKind[];
    };
    /** What the effect read needs. Absent: no effect is considered, and that is logged
     * when the flag is on. */
    effect?: {
      decider: LinqEffectDecider;
      audience: 'direct' | 'group';
      /** Parent-local zone for the quiet-hours fact. Absent: loaded from the user. */
      timeZone?: string;
      /** Prior effect in this chat. `undefined` reads send history; `null` means none. */
      lastEffectAt?: Date | null;
    };
  },
): Promise<LinqMoment> {
  if (args.route.channel !== 'imessage') return { handled: false };

  const tapback = await applyLinqTapback({
    channel: args.route.channel,
    chatId: args.route.chatId,
    inboundMessageId: args.route.replyToMessageId,
    inboundBody: args.inboundBody,
    outboundBody: args.outboundBody,
    fetch: args.fetch,
  });
  if (tapback.status === 'replaced') {
    const channelMessageId = await recordMoment(database, args, {
      templateKey: 'linq:tapback',
      actionTaken: 'linq_tapback',
      providerMessageId: args.route.replyToMessageId,
    });
    return { handled: true, channelMessageId, threadBody: null };
  }

  const imessage = { ...args, route: args.route };
  const sticker = await considerLinqSticker(database, imessage);
  if (sticker.status === 'handled') return sticker.moment;
  if (sticker.status === 'peeled') return { handled: false };

  return considerLinqEffect(database, imessage);
}

type StickerOutcome =
  | { status: 'none' }
  | { status: 'peeled' }
  | { status: 'handled'; moment: LinqMoment };

async function considerLinqSticker(
  database: Database,
  args: Parameters<typeof considerLinqReply>[1] & {
    route: Extract<ReplyRoute, { channel: 'imessage' }>;
  },
): Promise<StickerOutcome> {
  if (!linqStickersEnabled()) return { status: 'none' };
  const inboundMessageId = args.route.replyToMessageId;
  if (!args.sticker || !inboundMessageId) {
    console.info(
      { reason: args.sticker ? 'no_inbound_message_id' : 'no_decider' },
      'linq sticker: not considered',
    );
    return { status: 'none' };
  }
  // Stickers stack and a peel cannot be removed, so a re-driven turn whose reply failed
  // after the peel must not peel a second one onto the same message.
  const earlier = await database
    .select({
      templateKey: schema.channelMessages.templateKey,
      providerMessageId: schema.channelMessages.providerMessageId,
      familyId: schema.channelMessages.familyId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, args.familyId),
        eq(schema.channelMessages.providerMessageId, inboundMessageId),
        eq(schema.channelMessages.templateKey, 'linq:sticker'),
      ),
    )
    .limit(1);
  if (
    earlier.some(
      (row) =>
        row.templateKey === 'linq:sticker' &&
        row.providerMessageId === inboundMessageId &&
        row.familyId === args.familyId,
    )
  ) {
    console.info({ reason: 'already_peeled' }, 'linq sticker: not considered');
    return { status: 'none' };
  }
  const sticker = await applyLinqSticker({
    decider: args.sticker.decider,
    inboundMessageId,
    read: {
      audience: args.sticker.audience,
      parentText: args.inboundBody,
      parentAttachments: args.sticker.parentAttachments,
      reply: args.outboundBody,
    },
    fetch: args.fetch,
  });
  if (sticker.status !== 'peeled') return { status: 'none' };
  const channelMessageId = await recordMoment(database, args, {
    templateKey: 'linq:sticker',
    actionTaken: 'linq_sticker',
    providerMessageId: inboundMessageId,
  });
  // The reply still goes out, plain: one moment per reply.
  if (sticker.sendReply) return { status: 'peeled' };
  return { status: 'handled', moment: { handled: true, channelMessageId, threadBody: null } };
}

async function considerLinqEffect(
  database: Database,
  args: Parameters<typeof considerLinqReply>[1] & {
    route: Extract<ReplyRoute, { channel: 'imessage' }>;
  },
): Promise<LinqMoment> {
  if (!linqEffectsEnabled()) return { handled: false };
  if (!args.effect) {
    console.info({ reason: 'no_decider' }, 'linq effect: not considered');
    return { handled: false };
  }
  const timeZone =
    args.effect.timeZone ?? (await parentTimeZoneForOffer(database, args.parentUserId));
  const lastEffectAt =
    args.effect.lastEffectAt !== undefined
      ? args.effect.lastEffectAt
      : await lastLinqEffectAt(database, args.route.chatId);
  const hold = linqEffectHold({ now: args.now, timeZone, lastEffectAt });
  if (hold) {
    console.info({ reason: hold }, 'linq effect: held, reply goes plain');
    return { handled: false };
  }
  const sent = await applyLinqEffect({
    decider: args.effect.decider,
    chatId: args.route.chatId,
    text: args.outboundBody,
    replyToMessageId: args.route.replyToMessageId,
    read: {
      audience: args.effect.audience,
      parentText: args.inboundBody,
      reply: args.outboundBody,
    },
    fetch: args.fetch,
  });
  if (sent.status !== 'sent') return { handled: false };
  const channelMessageId = await recordMoment(database, args, {
    templateKey: 'linq:effect',
    actionTaken: 'linq_effect',
    providerMessageId: sent.providerMessageId,
  });
  return { handled: true, channelMessageId, threadBody: args.outboundBody };
}

async function recordMoment(
  database: Database,
  args: { familyId: string; parentUserId: string; route: ReplyRoute; now: Date },
  moment: { templateKey: string; actionTaken: string; providerMessageId: string | null },
): Promise<string> {
  const chatId = args.route.channel === 'imessage' ? args.route.chatId : null;
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: moment.templateKey,
      providerMessageId: moment.providerMessageId,
      providerChatId: chatId,
      status: acceptedStatus('imessage'),
      sentAt: args.now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) throw new Error('linq moment: channel_messages insert returned no row');
  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.parentUserId,
    actionTaken: moment.actionTaken,
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}
