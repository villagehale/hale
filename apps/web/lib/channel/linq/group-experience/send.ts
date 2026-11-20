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
  },
): Promise<{ providerMessageId: string }> {
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
    })
    .returning({ id: schema.channelMessages.id });
  if (!claimed) throw new Error('group experience: channel_messages insert returned no row');
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
    return sent;
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    throw err;
  }
}
