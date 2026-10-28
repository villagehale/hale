import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { primaryParentId } from '../roster-ask';
import { LinqSendError, sendLinqChatMessage } from '../transport';

/**
 * VIL-442 — one ledgered send into a claimed group for a plan tally or follow-up,
 * and (VIL-471) a group poll line.
 *
 * Claims the channel_messages row before Linq hears the line. A refusal marks
 * that same row failed. The covering family's primary parent owns the row.
 */
export const GROUP_PLAN_RSVP_TEMPLATE = 'linq:group_plan_rsvp';
export const GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE = 'linq:group_plan_rsvp_followup';
export const GROUP_POLL_TEMPLATE = 'linq:group_poll';

export async function sendGroupPlanRsvpLine(
  database: Database,
  input: {
    chatId: string;
    text: string;
    templateKey:
      | typeof GROUP_PLAN_RSVP_TEMPLATE
      | typeof GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE
      | typeof GROUP_POLL_TEMPLATE;
    now: Date;
  },
): Promise<{ providerMessageId: string }> {
  const [family] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, input.chatId))
    .limit(1);
  if (!family) {
    console.warn({ outcome: 'no_covering_family' }, 'group plan rsvp: send not ledgered');
    throw new Error('group plan rsvp: no covering family');
  }
  const parentUserId = await primaryParentId(database, family.id);
  if (!parentUserId) {
    console.warn(
      { familyId: family.id, outcome: 'no_primary_parent' },
      'group plan rsvp: send not ledgered',
    );
    throw new Error('group plan rsvp: no primary parent');
  }
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: family.id,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: `${input.templateKey}:${input.chatId}:${input.now.toISOString()}`,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
      body: input.text,
    })
    .returning({ id: schema.channelMessages.id });
  if (!claimed) throw new Error('group plan rsvp: channel_messages insert returned no row');
  try {
    const sent = await sendLinqChatMessage({ chatId: input.chatId, text: input.text });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: family.id,
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
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    throw err;
  }
}
