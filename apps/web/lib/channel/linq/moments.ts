import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { applyLinqTapback } from './tapback';

/**
 * The product moment on an iMessage reply: a tapback instead of a throwaway
 * ack. A miss falls through and the text still goes out. SMS and email never
 * call Linq from here. A year-find poll is not a reply moment.
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
      providerMessageId: args.route.replyToMessageId,
    });
    return { handled: true, channelMessageId, threadBody: null };
  }

  return { handled: false };
}

async function recordMoment(
  database: Database,
  args: { familyId: string; parentUserId: string; route: ReplyRoute; now: Date },
  moment: { templateKey: string; providerMessageId: string | null },
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
    actionTaken: 'linq_tapback',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}
