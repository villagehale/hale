import type { Database } from '@hale/db';
import { schema } from '@hale/db';
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
import { applyLinqTapback } from './tapback';

/**
 * The product moment on an iMessage reply: a tapback instead of a throwaway
 * ack, or (VIL-473, flag `LINQ_EFFECTS_ENABLED`) the reply sent with an
 * iMessage effect the model chose. A miss falls through and the text still
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
