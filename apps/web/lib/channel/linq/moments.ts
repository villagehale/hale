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
import {
  type LinqEffectDecider,
  type LinqEffectWithheld,
  applyLinqEffect,
  lastLinqEffectAt,
  linqEffectClockFacts,
  linqEffectsEnabled,
  parentStoredTimeZone,
} from './effect';
import { resolveGroupMention } from './group-mention-reader';
import { type LinqStickerDecider, applyLinqSticker, linqStickersEnabled } from './sticker';
import { applyLinqTapback } from './tapback';

/**
 * The product moment on an iMessage reply: a tapback instead of a throwaway
 * ack, (VIL-479, flag `LINQ_MESSAGE_EDIT_ENABLED`) an edit of a bubble Hale just
 * sent when the model says the follow-up only corrects it, or (VIL-472, flag
 * `LINQ_STICKERS_ENABLED`) a sticker the model chose, peeled onto the parent's
 * message, or (VIL-473, flag `LINQ_EFFECTS_ENABLED`) the reply itself sent with an
 * iMessage effect the model chose. At most one moment per reply: a peeled sticker
 * means the reply goes plain. A miss falls through and the text still
 * goes out. SMS and email never call Linq from here. A year-find poll is not a
 * reply moment.
 */

export type LinqMoment =
  | { handled: false }
  | { handled: true; channelMessageId: string; threadBody: string | null }
  /**
   * The reply's own words went out, carrying an effect. Nothing is on the ledger yet:
   * the caller writes the reply's receipts exactly as for a plain send, and never sends
   * the words again. `unknown` is a POST that may have landed (a timeout, a Linq 5xx,
   * no id): its row says so, and the caller pages ops with it.
   */
  | { handled: 'effect'; delivery: 'sent'; providerMessageId: string }
  | { handled: 'effect'; delivery: 'unknown'; providerMessageId: null };

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
    /**
     * The reply goes out as several bubbles and this is the first. Every read still sees
     * the whole reply (`outboundBody`), but nothing stands in for a set: no tapback, no
     * edit, and a peeled sticker leaves the words to go plain. An effect rides this bubble
     * alone, under `sendKey`: the key the bubble's own send carries, so the effect and a
     * plain resend of the same bubble are one send to Linq. Absent: the reply is one bubble.
     */
    firstOfSeveral?: { text: string; sendKey: string };
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
    /** What the effect read needs, or why this reply is withheld from it. Absent: no
     * effect is considered. Either is logged by name when the flag is on. */
    effect?:
      | {
          decider: LinqEffectDecider;
          audience: 'direct' | 'group';
          /** Parent-local zone for the wall-clock fact. `undefined` reads the user row;
           * `null` means none is stored. */
          timeZone?: string | null;
          /** Prior effect in this chat. `undefined` reads send history; `null` means none. */
          lastEffectAt?: Date | null;
        }
      | { withheld: LinqEffectWithheld };
  },
): Promise<LinqMoment> {
  if (args.route.channel !== 'imessage') return { handled: false };
  const standalone = args.firstOfSeveral === undefined;

  if (standalone) {
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
  }

  if (linqMessageEditEnabled()) {
    if (!standalone) {
      console.info({ reason: 'several_bubbles' }, 'linq edit: not considered');
    } else if (!args.edit) {
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

  if (linqStickersEnabled()) {
    const inboundMessageId = args.route.replyToMessageId;
    if (!args.sticker || !inboundMessageId) {
      console.info(
        { reason: args.sticker ? 'no_inbound_message_id' : 'no_decider' },
        'linq sticker: not considered',
      );
    } else {
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
      const alreadyPeeled = earlier.some(
        (row) =>
          row.templateKey === 'linq:sticker' &&
          row.providerMessageId === inboundMessageId &&
          row.familyId === args.familyId,
      );
      if (alreadyPeeled) {
        console.info({ reason: 'already_peeled' }, 'linq sticker: not considered');
      } else {
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
        if (sticker.status === 'peeled') {
          const channelMessageId = await recordMoment(database, args, {
            templateKey: 'linq:sticker',
            actionTaken: 'linq_sticker',
            providerMessageId: inboundMessageId,
          });
          // One moment per reply: the words, if they still go, go plain. A sticker
          // never stands in for an answer of several bubbles.
          if (sticker.sendReply || !standalone) return { handled: false };
          return { handled: true, channelMessageId, threadBody: null };
        }
      }
    }
  }

  if (!linqEffectsEnabled()) return { handled: false };
  // A reply that already has its own ledger key (a holding line, a flood line,
  // a handler receipt) keeps that key. An effect reply's row is keyed `linq:effect`,
  // and the cap or audit that reads the reply's own key would miss it.
  if (args.templateKey) {
    console.info({ reason: 'keyed_reply' }, 'linq effect: not considered');
    return { handled: false };
  }
  if (!args.effect) {
    console.info({ reason: 'no_decider' }, 'linq effect: not considered');
    return { handled: false };
  }
  if ('withheld' in args.effect) {
    console.info({ reason: args.effect.withheld }, 'linq effect: not considered');
    return { handled: false };
  }
  const timeZone =
    args.effect.timeZone !== undefined
      ? args.effect.timeZone
      : await parentStoredTimeZone(database, args.parentUserId);
  const lastEffectAt =
    args.effect.lastEffectAt !== undefined
      ? args.effect.lastEffectAt
      : await lastLinqEffectAt(database, args.route.chatId);
  const chatId = args.route.chatId;
  const sent = await applyLinqEffect({
    decider: args.effect.decider,
    chatId,
    ...(args.firstOfSeveral
      ? { text: args.firstOfSeveral.text, sendKey: args.firstOfSeveral.sendKey }
      : { text: args.outboundBody }),
    replyToMessageId: args.route.replyToMessageId,
    read: {
      audience: args.effect.audience,
      parentText: args.inboundBody,
      reply: args.outboundBody,
      ...linqEffectClockFacts({ now: args.now, timeZone, lastEffectAt }),
    },
    // The same resolver the plain reply transport asks (router/wiring.ts), so a group
    // reply sent with an effect keeps its mention.
    mentionFor: () => resolveGroupMention({ database, chatId, text: args.outboundBody }),
    fetch: args.fetch,
  });
  // A decline or a definite refusal did not land. An uncertain POST may have.
  if (sent.status === 'declined' || sent.status === 'not_sent') return { handled: false };
  return sent.status === 'sent'
    ? { handled: 'effect', delivery: 'sent', providerMessageId: sent.providerMessageId }
    : { handled: 'effect', delivery: 'unknown', providerMessageId: null };
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
