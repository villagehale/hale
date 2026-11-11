import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { InboundMediaKind } from '~/lib/channel/inbound-media';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import {
  type EditableLinqSend,
  type LinqEditDecider,
  applyLinqEdit,
  linqMessageEditEnabled,
} from './edit';
import { type LinqStickerDecider, applyLinqSticker, linqStickersEnabled } from './sticker';
import { applyLinqTapback } from './tapback';

/**
 * The product moment on an iMessage reply: a tapback instead of a throwaway
 * ack, (VIL-479, flag `LINQ_MESSAGE_EDIT_ENABLED`) an edit of a bubble Hale just
 * sent when the model says the follow-up only corrects it, or (VIL-472, flag
 * `LINQ_STICKERS_ENABLED`) a sticker the model chose, peeled onto the parent's
 * message. A miss falls through and the text still
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
    /** Bubbles the edit read may replace. Absent: no edit is considered, and that is
     * logged when the flag is on. */
    edit?: {
      decider: LinqEditDecider;
      candidates: readonly EditableLinqSend[];
      audience: 'direct' | 'group';
      conversationId: string;
    };
    /** What the sticker read needs. Absent: no sticker is considered, and that is logged
     * when the flag is on. */
    sticker?: {
      decider: LinqStickerDecider;
      audience: 'direct' | 'group';
      parentAttachments: readonly InboundMediaKind[];
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

  if (linqMessageEditEnabled()) {
    if (!args.edit) {
      console.info({ reason: 'no_decider' }, 'linq edit: not considered');
    } else if (args.edit.candidates.length === 0) {
      console.info({ reason: 'nothing_editable' }, 'linq edit: not considered');
    } else if (args.route.channel === 'imessage') {
      const edited = await applyLinqEdit({
        decider: args.edit.decider,
        database,
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        conversationId: args.edit.conversationId,
        chatId: args.route.chatId,
        now: args.now,
        read: {
          audience: args.edit.audience,
          parentText: args.inboundBody,
          followUp: args.outboundBody,
        },
        candidates: args.edit.candidates,
        fetch: args.fetch,
      });
      if (edited.status === 'edited') {
        return { handled: true, channelMessageId: edited.channelMessageId, threadBody: null };
      }
    }
  }

  if (!linqStickersEnabled()) return { handled: false };
  const inboundMessageId = args.route.replyToMessageId;
  if (!args.sticker || !inboundMessageId) {
    console.info(
      { reason: args.sticker ? 'no_inbound_message_id' : 'no_decider' },
      'linq sticker: not considered',
    );
    return { handled: false };
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
    return { handled: false };
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
  if (sticker.status !== 'peeled') return { handled: false };
  const channelMessageId = await recordMoment(database, args, {
    templateKey: 'linq:sticker',
    actionTaken: 'linq_sticker',
    providerMessageId: inboundMessageId,
  });
  if (sticker.sendReply) return { handled: false };
  return { handled: true, channelMessageId, threadBody: null };
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
