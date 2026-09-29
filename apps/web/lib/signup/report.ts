import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';

export interface GroupSignupDelivery {
  familyId: string;
  parentUserId: string;
  chatId: string;
  body: string;
  dedupeKey: string;
  now: Date;
}

const refusedNewThread: ChannelTransport = {
  async send() {
    throw new Error('authorized_signup_refused_new_1_1');
  },
};

/**
 * The result goes to the co-parent group. The ledger row is written before
 * the send and stores no body. A failure is named; this function does not
 * open an SMS thread.
 */
export async function sendSignupToGroup(
  database: Database,
  input: GroupSignupDelivery,
): Promise<'sent' | 'failed' | 'already_sent'> {
  const inserted = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'authorized_signup',
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: 'queued',
      sentAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  const row = inserted[0];
  if (!row) return 'already_sent';
  try {
    const delivered = await deliverFamilyOutbound(database, {
      familyId: input.familyId,
      body: input.body,
      to: '',
      legacy: refusedNewThread,
      target: { channel: 'group', chatId: input.chatId, familyId: input.familyId },
      shareGroupCap: false,
      bubbleKind: 'uncapped',
      now: input.now,
    });
    if (delivered.status !== 'sent') {
      await markFailed(database, row.id, input.familyId, delivered.reason);
      return 'failed';
    }
    await database
      .update(schema.channelMessages)
      .set({
        status: 'sent',
        providerMessageId: delivered.providerMessageId,
        sentAt: input.now,
      })
      .where(
        and(
          eq(schema.channelMessages.id, row.id),
          eq(schema.channelMessages.familyId, input.familyId),
        ),
      );
    return 'sent';
  } catch (err) {
    const code = err instanceof Error ? err.message : 'send_threw';
    await markFailed(database, row.id, input.familyId, code.slice(0, 80));
    return 'failed';
  }
}

async function markFailed(
  database: Database,
  id: string,
  familyId: string,
  errorCode: string,
): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode })
    .where(and(eq(schema.channelMessages.id, id), eq(schema.channelMessages.familyId, familyId)));
}
