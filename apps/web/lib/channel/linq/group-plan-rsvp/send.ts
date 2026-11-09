import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import { type GroupHoldReason, groupAudienceAllows } from '../group-audience';
import type { ListChatHandles } from '../roster';
import { primaryParentId } from '../roster-ask';
import { LinqSendError, listLinqParticipantHandles } from '../transport';

/**
 * VIL-442 — one ledgered send into a claimed group for a plan tally or follow-up,
 * and (VIL-471) a group poll line.
 *
 * Claims the channel_messages row before Linq hears the line. A refusal marks
 * that same row failed. The covering family's primary parent owns the row.
 *
 * Before the claim, the family-chat floor reads who is in the chat now: a tally, a
 * follow-up and a poll line are `event_logistics`. A refused verdict claims nothing,
 * sends nothing and throws {@link GroupPlanRsvpHeld} with the floor's reason, so every
 * caller (which already treats a throw as "nothing landed") can name it.
 */
export const GROUP_PLAN_RSVP_TEMPLATE = 'linq:group_plan_rsvp';
export const GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE = 'linq:group_plan_rsvp_followup';
export const GROUP_POLL_TEMPLATE = 'linq:group_poll';
export const GROUP_PLAN_CALENDAR_ASK_TEMPLATE = 'linq:group_plan_calendar_ask';
export const GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE = 'linq:group_plan_calendar_written';
export const GROUP_PLAN_CALENDAR_REMOVED_TEMPLATE = 'linq:group_plan_calendar_removed';

export class GroupPlanRsvpHeld extends Error {
  constructor(readonly reason: GroupHoldReason) {
    super(`group plan rsvp: the family group may not hear it (${reason})`);
    this.name = 'GroupPlanRsvpHeld';
  }
}

export async function sendGroupPlanRsvpLine(
  database: Database,
  input: {
    chatId: string;
    text: string;
    templateKey:
      | typeof GROUP_PLAN_RSVP_TEMPLATE
      | typeof GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE
      | typeof GROUP_POLL_TEMPLATE
      | typeof GROUP_PLAN_CALENDAR_ASK_TEMPLATE
      | typeof GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE
      | typeof GROUP_PLAN_CALENDAR_REMOVED_TEMPLATE;
    now: Date;
    listChatHandles?: ListChatHandles;
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
  const audience = await groupAudienceAllows(
    database,
    input.chatId,
    'event_logistics',
    input.listChatHandles ?? listLinqParticipantHandles,
  );
  if (!audience.allowed) {
    console.info(
      { familyId: family.id, outcome: 'group_plan_rsvp_held', reason: audience.reason },
      'group plan rsvp: the family group may not hear it, nothing sent',
    );
    throw new GroupPlanRsvpHeld(audience.reason);
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
