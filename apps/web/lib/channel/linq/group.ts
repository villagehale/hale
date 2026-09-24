import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { haleContactImageUrl } from './contact-card';
import { linqFromE164 } from './config';
import {
  LinqSendError,
  addLinqParticipant,
  createLinqChat,
  listLinqParticipantHandles,
  removeLinqParticipant,
  sendLinqChatMessage,
  updateLinqGroupChat,
} from './transport';

/**
 * VIL-335 phase (b) — one household group, not a classmate-logistics brand.
 *
 * Hale, the enrolled parent, and their co-parent share the kids-year thread.
 * Every known handle maps through the phone blind index onto that same family.
 * An unknown number is acknowledged and not enrolled. The group chat id is
 * stored on the family so a later invite adds to it instead of opening another.
 */

/**
 * DESIGN LOCK PENDING (Sloane). First bubble when Hale opens the co-parent
 * group. No URL: Linq rejects a link on the create-chat message.
 */
export const LINQ_GROUP_OPEN_TEXT = "This thread is your kids' year — both of you, and me.";

/** DESIGN LOCK PENDING (Sloane). Group icon / name. Not a logistics brand. */
export const LINQ_GROUP_DISPLAY_NAME = "Kids' year";

/**
 * DESIGN LOCK PENDING (Sloane). Sent in the 1:1 when Linq will not open the
 * group. The sandbox requires the co-parent to have texted the line first.
 */
export const LINQ_GROUP_UNREACHABLE_TEXT =
  "I couldn't open the group yet. Ask them to text this number once, then say try the group again.";

/**
 * DESIGN LOCK PENDING (Sloane). Hold for a number in the group that is not an
 * enrolled parent of this household. Does not start an intake.
 */
export const LINQ_GROUP_UNKNOWN_HOLD =
  "I only keep this household's year with parents already on Hale. Text me one to one if that's you.";

export type GroupFamilyMap =
  | { status: 'same_family'; familyId: string; userId: string }
  | { status: 'unknown_sender' }
  | { status: 'mixed_family' };

/**
 * Map handles to one family. `sender` is required. `others` are the rest of
 * the chat when Linq told us who is in it; an empty list means the webhook
 * did not include them (message.received does not), and the sender alone decides.
 */
export async function mapGroupHandlesToFamily(
  database: Database,
  input: { sender: string; others: readonly string[] },
): Promise<GroupFamilyMap> {
  const sender = await resolveVerifiedChannelByPhone(database, input.sender);
  if (!sender) return { status: 'unknown_sender' };
  for (const handle of input.others) {
    const canonical = normalizePhoneE164(handle);
    if (!canonical) return { status: 'mixed_family' };
    const member = await resolveVerifiedChannelByPhone(database, canonical);
    if (!member || member.familyId !== sender.familyId) return { status: 'mixed_family' };
  }
  return { status: 'same_family', familyId: sender.familyId, userId: sender.userId };
}

/** Remember the group on the family when none is stored yet. A different id
 * already stored is left alone — the reply still uses the inbound chat. */
export async function rememberLinqGroupChat(
  database: Database,
  input: { familyId: string; chatId: string; now: Date },
): Promise<'stored' | 'already_this' | 'already_other'> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId));
  const row = rows.find((candidate) => candidate.id === input.familyId);
  if (!row) return 'already_other';
  if (row.linqGroupChatId === input.chatId) return 'already_this';
  if (row.linqGroupChatId) return 'already_other';
  const [updated] = await database
    .update(schema.families)
    .set({ linqGroupChatId: input.chatId, updatedAt: input.now })
    .where(and(eq(schema.families.id, input.familyId), isNull(schema.families.linqGroupChatId)))
    .returning({ id: schema.families.id });
  return updated ? 'stored' : 'already_other';
}

export type OpenHouseholdGroupOutcome =
  | { status: 'opened'; chatId: string }
  | { status: 'added'; chatId: string }
  | {
      status: 'skipped';
      reason:
        | 'not_imessage'
        | 'no_from'
        | 'no_chat'
        | 'not_configured'
        | 'same_number'
        | 'unavailable';
    }
  | { status: 'degraded'; reason: 'coparent_not_reachable'; code: string; httpStatus: number };

/**
 * Parent is live 1:1 on Linq. Open a group with Hale's line, that parent, and
 * the co-parent — or add the co-parent when the household group already exists.
 * A partner refusal is a named degrade in the 1:1, not a failed invite.
 */
export async function openHouseholdLinqGroup(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    parentPhoneE164: string;
    coParentPhoneE164: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<OpenHouseholdGroupOutcome> {
  const parent = normalizePhoneE164(args.parentPhoneE164);
  const coParent = normalizePhoneE164(args.coParentPhoneE164);
  if (!parent || !coParent || parent === coParent) {
    return { status: 'skipped', reason: 'same_number' };
  }

  let chatIdForDegrade: string | null = null;
  try {
    const door = await resolveMessagingDoor(database, args.parentUserId);
    if (door.channel !== 'imessage' || !door.chatId) {
      return {
        status: 'skipped',
        reason: door.channel === 'imessage' ? 'no_chat' : 'not_imessage',
      };
    }
    chatIdForDegrade = door.chatId;
    const from = linqFromE164();
    if (!from) {
      console.warn(
        { familyId: args.familyId },
        'linq group: LINQ_FROM_E164 is unset — the co-parent group was not opened',
      );
      return { status: 'skipped', reason: 'no_from' };
    }

    const existing = await database
      .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
      .from(schema.families)
      .where(eq(schema.families.id, args.familyId));
    const groupId = existing.find((row) => row.id === args.familyId)?.linqGroupChatId ?? null;

    if (groupId) {
      await addLinqParticipant({ chatId: groupId, handle: coParent, fetch: args.fetch });
      await database.insert(schema.auditLog).values({
        familyId: args.familyId,
        actor: args.parentUserId,
        actionTaken: 'linq_group_opened',
        targetTable: 'families',
        targetId: args.familyId,
        after: { outcome: 'added' },
      });
      return { status: 'added', chatId: groupId };
    }

    const created = await createLinqChat({
      from,
      to: [parent, coParent],
      text: LINQ_GROUP_OPEN_TEXT,
      fetch: args.fetch,
    });
    await updateLinqGroupChat({
      chatId: created.chatId,
      displayName: LINQ_GROUP_DISPLAY_NAME,
      iconUrl: haleContactImageUrl(),
      fetch: args.fetch,
    });
    await database
      .update(schema.families)
      .set({ linqGroupChatId: created.chatId, updatedAt: args.now })
      .where(eq(schema.families.id, args.familyId));
    await database.insert(schema.channelMessages).values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:group_open',
      providerMessageId: created.providerMessageId,
      providerChatId: created.chatId,
      status: acceptedStatus('imessage'),
      sentAt: args.now,
    });
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_group_opened',
      targetTable: 'families',
      targetId: args.familyId,
      after: { outcome: 'opened' },
    });
    return { status: 'opened', chatId: created.chatId };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      return { status: 'skipped', reason: 'not_configured' };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn(
      { familyId: args.familyId, code, httpStatus },
      'linq group: the co-parent group was not opened',
    );
    if (!chatIdForDegrade) return { status: 'skipped', reason: 'unavailable' };
    await tellParentTheGroupDidNotOpen(database, args, chatIdForDegrade);
    return { status: 'degraded', reason: 'coparent_not_reachable', code, httpStatus };
  }
}

async function tellParentTheGroupDidNotOpen(
  database: Database,
  args: { familyId: string; parentUserId: string; now: Date; fetch?: typeof fetch },
  chatId: string,
): Promise<void> {
  try {
    const sent = await sendLinqChatMessage({
      chatId,
      text: LINQ_GROUP_UNREACHABLE_TEXT,
      fetch: args.fetch,
    });
    await database.insert(schema.channelMessages).values({
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:group_unreachable',
      providerMessageId: sent.providerMessageId,
      providerChatId: chatId,
      status: acceptedStatus('imessage'),
      sentAt: args.now,
    });
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_group_held',
      targetTable: 'families',
      targetId: args.familyId,
      after: { outcome: 'coparent_not_reachable' },
    });
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn({ familyId: args.familyId, code }, 'linq group: the degrade text did not land');
  }
}

/** Best-effort hold into a group Hale will not enroll a stranger from. */
export async function holdUnknownGroupSender(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<'sent' | 'not_sent'> {
  try {
    await sendLinqChatMessage({
      chatId: input.chatId,
      text: LINQ_GROUP_UNKNOWN_HOLD,
      fetch: input.fetch,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn({ code, httpStatus }, 'linq group: unknown-sender hold did not land');
    return 'not_sent';
  }
}

/** Re-export so the co-parent flow and tests share one remove helper. */
export { removeLinqParticipant, listLinqParticipantHandles };
