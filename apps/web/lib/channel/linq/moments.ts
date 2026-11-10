import type { Database, MedicalReplySourceValue, ReplySourceValue } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { InboundMediaKind } from '~/lib/channel/inbound-media';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import {
  type LinqEffectDecider,
  applyLinqEffect,
  lastLinqEffectAt,
  linqEffectClockFacts,
  linqEffectsEnabled,
  parentStoredTimeZone,
} from './effect';
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
 * message, or (VIL-473, flag `LINQ_EFFECTS_ENABLED`) the reply sent with an
 * iMessage effect the model chose. At most one moment per reply: a peeled sticker
 * means the reply goes plain. A miss falls through and the text still goes out.
 * SMS and email never call Linq from here. A year-find poll is not a reply moment.
 */

export type LinqMoment =
  | { handled: false }
  | { handled: true; channelMessageId: string; threadBody: string | null };

/**
 * Linq already accepted this moment (or the POST's outcome is unknowable).
 * The ledger write failed afterwards, so neither the outbound row nor its audit
 * row exists: they are one transaction. The caller must not send the reply again.
 */
export class LinqMomentDeliveredError extends Error {
  readonly providerMessageId: string | null;
  readonly threadBody: string | null;

  constructor(providerMessageId: string | null, threadBody: string | null) {
    super('linq moment delivered');
    this.name = 'LinqMomentDeliveredError';
    this.providerMessageId = providerMessageId;
    this.threadBody = threadBody;
  }
}

export async function considerLinqReply(
  database: Database,
  args: {
    route: ReplyRoute;
    inboundBody: string;
    outboundBody: string;
    templateKey: string | null;
    /** The reply's own provenance. An effect send keeps these on its outbound row. */
    medicalReplySource?: MedicalReplySourceValue | null;
    replySource?: ReplySourceValue | null;
    relatedConversationId?: string | null;
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
    /** What the effect read needs. Absent: no effect is considered, and that is logged
     * when the flag is on. */
    effect?: {
      decider: LinqEffectDecider;
      audience: 'direct' | 'group';
      /** Parent-local zone for the wall-clock fact. `undefined` reads the user row;
       * `null` means none is stored. */
      timeZone?: string | null;
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

  if (linqMessageEditEnabled()) {
    if (!args.edit) {
      console.info({ reason: 'no_decider' }, 'linq edit: not considered');
    } else if (args.edit.candidates.length === 0) {
      console.info({ reason: 'nothing_editable' }, 'linq edit: not considered');
    } else {
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
          // One moment per reply: the words, if they still go, go plain.
          if (sticker.sendReply) return { handled: false };
          return { handled: true, channelMessageId, threadBody: null };
        }
      }
    }
  }

  if (!linqEffectsEnabled()) return { handled: false };
  // A reply that already has its own ledger key (a holding line, a flood line,
  // a handler receipt) keeps that key. An effect would replace it with
  // `linq:effect`, and the cap or audit that reads the key would miss the reply.
  if (args.templateKey) {
    console.info({ reason: 'keyed_reply' }, 'linq effect: not considered');
    return { handled: false };
  }
  if (!args.effect) {
    console.info({ reason: 'no_decider' }, 'linq effect: not considered');
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
  const sent = await applyLinqEffect({
    decider: args.effect.decider,
    chatId: args.route.chatId,
    text: args.outboundBody,
    replyToMessageId: args.route.replyToMessageId,
    read: {
      audience: args.effect.audience,
      parentText: args.inboundBody,
      reply: args.outboundBody,
      ...linqEffectClockFacts({ now: args.now, timeZone, lastEffectAt }),
    },
    fetch: args.fetch,
  });
  // A decline or a definite refusal did not land. An uncertain POST may have.
  if (sent.status === 'declined' || sent.status === 'not_sent') return { handled: false };
  const providerMessageId = sent.status === 'sent' ? sent.providerMessageId : null;
  let channelMessageId: string;
  try {
    channelMessageId = await recordMoment(database, args, {
      templateKey: 'linq:effect',
      actionTaken: 'linq_effect',
      providerMessageId,
    });
  } catch (err) {
    console.error(
      {
        code: err instanceof Error ? err.name : 'unknown',
        providerMessageId,
      },
      'linq effect: delivered; ledger write failed',
    );
    throw new LinqMomentDeliveredError(providerMessageId, args.outboundBody);
  }
  return { handled: true, channelMessageId, threadBody: args.outboundBody };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The outbound row and its audit row, in one transaction (rule #6): a moment is
 * never on the ledger without its audit row.
 */
async function recordMoment(
  database: Database,
  args: Parameters<typeof writeMomentRow>[1],
  moment: { templateKey: string; actionTaken: string; providerMessageId: string | null },
): Promise<string> {
  return database.transaction(async (tx) => {
    const id = await writeMomentRow(tx, args, moment);
    await writeMomentAudit(tx, args, id, moment.actionTaken);
    return id;
  });
}

/**
 * The outbound row. `templateKey` on an effect is `linq:effect`: that marker is
 * how the next effect read finds this chat's last effect, one column, no join. The reply's own template key,
 * when it had one, is on the audit so it is not discarded. Medical source,
 * deflection source and the conversation stay on this row — the safety and
 * papercut counts read those columns, and an effect must not erase them.
 */
async function writeMomentRow(
  database: Tx,
  args: {
    familyId: string;
    parentUserId: string;
    route: ReplyRoute;
    now: Date;
    templateKey?: string | null;
    medicalReplySource?: MedicalReplySourceValue | null;
    replySource?: ReplySourceValue | null;
    relatedConversationId?: string | null;
  },
  moment: { templateKey: string; providerMessageId: string | null },
): Promise<string> {
  const chatId = args.route.channel === 'imessage' ? args.route.chatId : null;
  // Only the effect send is the reply itself. A tapback or a sticker is a
  // reaction on the parent's message, and the reply's sources stay with the
  // text when that text still goes out.
  const carriesReply = moment.templateKey === 'linq:effect';
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
      medicalReplySource: carriesReply ? (args.medicalReplySource ?? null) : null,
      replySource: carriesReply ? (args.replySource ?? null) : null,
      relatedConversationId: carriesReply ? (args.relatedConversationId ?? null) : null,
      sentAt: args.now,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) throw new Error('linq moment: channel_messages insert returned no row');
  return id;
}

async function writeMomentAudit(
  database: Tx,
  args: {
    familyId: string;
    parentUserId: string;
    templateKey?: string | null;
  },
  channelMessageId: string,
  actionTaken: string,
): Promise<void> {
  const replyTemplateKey = actionTaken === 'linq_effect' ? (args.templateKey ?? null) : null;
  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.parentUserId,
    actionTaken,
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    // The row's template key is the effect marker. The reply's own key lives here.
    ...(replyTemplateKey ? { after: { templateKey: replyTemplateKey } } : {}),
  });
}
