import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import { type GroupHoldReason, groupAudienceAllows } from '../group-audience';
import type { ListChatHandles } from '../roster';
import { primaryParentId } from '../roster-ask';
import { LinqSendError, listLinqParticipantHandles } from '../transport';
import { GROUP_EXPERIENCE_TEMPLATE } from './kinds';

export class GroupExperienceHeld extends Error {
  constructor(readonly reason: GroupHoldReason) {
    super(`group experience: the family group may not hear it (${reason})`);
    this.name = 'GroupExperienceHeld';
  }
}

export async function sendGroupExperienceLine(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    text: string;
    now: Date;
    fetch?: typeof fetch;
    send?: (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
    listChatHandles?: ListChatHandles;
    /** One group line per inbound message: a redelivered webhook claims the same key. */
    dedupeKey: string;
  },
): Promise<{ providerMessageId: string } | { duplicate: true }> {
  const parentUserId = await primaryParentId(database, input.familyId);
  if (!parentUserId) throw new Error('group experience: covering family has no primary parent');
  const listChatHandles: ListChatHandles =
    input.listChatHandles ?? ((i) => listLinqParticipantHandles({ ...i, fetch: input.fetch }));
  const audience = await groupAudienceAllows(
    database,
    input.chatId,
    'event_logistics',
    listChatHandles,
  );
  if (!audience.allowed) throw new GroupExperienceHeld(audience.reason);
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: GROUP_EXPERIENCE_TEMPLATE,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
      body: input.text,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { duplicate: true };
  try {
    const sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text })
      : await sendLinqChatMessage({
          chatId: input.chatId,
          text: input.text,
          fetch: input.fetch,
        });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
    });
    return sent;
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    throw err;
  }
}
