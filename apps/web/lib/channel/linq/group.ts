import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { linqFromE164 } from './config';
import { haleContactImageUrl } from './contact-card';
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

/** DESIGN LOCK PENDING (Sloane). Group icon / name. Household dad+mom only, not a logistics brand. */
export const LINQ_GROUP_DISPLAY_NAME = "Kids' year";

/**
 * DESIGN LOCK PENDING (Sloane). Sent in the 1:1 when Linq will not open the
 * group. The sandbox requires the co-parent to have texted the line first.
 */
export const LINQ_GROUP_UNREACHABLE_TEXT =
  "I couldn't open the group yet. Ask them to text this number once, then tell me to try again.";

/**
 * DESIGN LOCK PENDING (Sloane). Hold for a number in the group that is not an
 * enrolled parent of this household. Does not start an intake.
 */
export const LINQ_GROUP_UNKNOWN_HOLD =
  "I only keep this household's year with parents already on Hale. Text me one to one if that's you.";

/**
 * Design locked (2026-09-24, #706). The whole message a parent sends in the
 * iMessage group they started, and nothing else. Hale claims that chat when
 * this arrives from an enrolled parent. A sentence that merely contains it
 * is not the trigger.
 */
export const LINQ_GROUP_TRIGGER_PHRASE: Record<ReplyLanguage, string> = {
  en: 'this is our year',
  fr: 'cest notre annee',
};

/**
 * Design locked (2026-09-24, #706). Told in the 1:1 after the co-parent number.
 * Hale does not text that number and does not create the group.
 */
export function linqGroupMakeInstruction(line: string, language: ReplyLanguage): string {
  const phrase = LINQ_GROUP_TRIGGER_PHRASE[language];
  return language === 'fr'
    ? `Ouvre un groupe iMessage avec eux et ce numero: ${line}. Dans ce groupe, envoie: ${phrase}.`
    : `Start an iMessage group with them and this number: ${line}. In that group, send: ${phrase}.`;
}

/**
 * Design locked (Sloane, 2026-09-25). The co-parent ask on Linq, one bubble.
 * `{line}` is Hale's number. No "text me their number", no invite promise.
 */
export function linqCoParentAsk(line: string, language: ReplyLanguage): string {
  const lead =
    language === 'fr'
      ? "Tu veux l'autre parent sur l'annee des enfants aussi?"
      : "Want the other parent on the kids' year too?";
  return `${lead} ${linqGroupMakeInstruction(line, language)}`;
}

/**
 * Design locked (2026-09-24, #706). The trigger arrived in the 1:1. Hale does
 * not claim a group from that chat.
 */
export function linqGroupTriggerInOneToOne(line: string, language: ReplyLanguage): string {
  const phrase = LINQ_GROUP_TRIGGER_PHRASE[language];
  return language === 'fr'
    ? `Cette phrase va dans le groupe. Ouvrez un groupe iMessage avec eux et ${line}, puis envoyez: ${phrase}.`
    : `That phrase belongs in the group. Start an iMessage group with them and ${line}, then send: ${phrase}.`;
}

/** Design locked (2026-09-24, #706). This chat cannot become the household thread. */
export const LINQ_GROUP_CLAIM_REFUSED_TEXT: Record<ReplyLanguage, string> = {
  en: "I can't use this thread as your kids' year.",
  fr: "Je ne peux pas utiliser ce fil comme l'annee de vos enfants.",
};

/** Ack after a claim. The body is {@link LINQ_GROUP_OPEN_TEXT}. */
export const LINQ_GROUP_CLAIMED_TEMPLATE_KEY = 'linq:group_claimed';
/** Refusal when this chat is already another household, or this household already has one. */
export const LINQ_GROUP_CLAIM_REFUSED_TEMPLATE_KEY = 'linq:group_claim_refused';
/** The trigger arrived in the 1:1. The body is {@link linqGroupTriggerInOneToOne}. */
export const LINQ_GROUP_TRIGGER_1TO1_TEMPLATE_KEY = 'linq:group_trigger_1to1';

/** Design locked (2026-09-24, #706). Hale has no line to tell the parent to add. */
export const LINQ_GROUP_LINE_MISSING_TEXT: Record<ReplyLanguage, string> = {
  en: "I don't have a number for you to add to a group yet.",
  fr: "Je n'ai pas encore de numero a ajouter a un groupe.",
};

/** A parent-facing rendering of Hale's E.164. NANP numbers read as a phone. */
export function formatLinqLineForParent(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return e164;
}

/** The trigger, or null. Trailing punctuation does not count as a different phrase. */
export function matchLinqGroupTrigger(body: string): ReplyLanguage | null {
  const normalized = body
    .trim()
    .replace(/[.!]+$/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (normalized === LINQ_GROUP_TRIGGER_PHRASE.en) return 'en';
  if (normalized === LINQ_GROUP_TRIGGER_PHRASE.fr) return 'fr';
  return null;
}

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

export type ClaimHouseholdGroupOutcome =
  | { status: 'claimed'; chatId: string }
  | { status: 'already_this'; chatId: string }
  | { status: 'already_other_chat' }
  | { status: 'claimed_by_other_family' }
  | { status: 'family_missing' };

/**
 * Write `families.linq_group_chat_id` for a group the parent already made.
 *
 * This is the claim. A hand-made group is not the household thread until this
 * column holds its chat id. A chat already stored on another family is refused.
 * A family that already has a different chat keeps that one.
 */
export async function claimHouseholdLinqGroup(
  database: Database,
  input: { familyId: string; parentUserId: string; chatId: string; now: Date },
): Promise<ClaimHouseholdGroupOutcome> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  const holder = rows.find((row) => row.linqGroupChatId === input.chatId);
  if (holder && holder.id !== input.familyId) return { status: 'claimed_by_other_family' };
  const mine = rows.find((row) => row.id === input.familyId);
  if (!mine) return { status: 'family_missing' };
  if (mine.linqGroupChatId === input.chatId)
    return { status: 'already_this', chatId: input.chatId };
  if (mine.linqGroupChatId) return { status: 'already_other_chat' };

  const [updated] = await database
    .update(schema.families)
    .set({ linqGroupChatId: input.chatId, updatedAt: input.now })
    .where(and(eq(schema.families.id, input.familyId), isNull(schema.families.linqGroupChatId)))
    .returning({ id: schema.families.id });
  if (!updated || updated.id !== input.familyId) {
    const again = (
      await database
        .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
        .from(schema.families)
    ).find((row) => row.id === input.familyId);
    if (again?.linqGroupChatId === input.chatId)
      return { status: 'already_this', chatId: input.chatId };
    if (again?.linqGroupChatId) return { status: 'already_other_chat' };
    return { status: 'claimed_by_other_family' };
  }

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'linq_group_claimed',
    targetTable: 'families',
    targetId: input.familyId,
    after: { outcome: 'claimed' },
  });
  return { status: 'claimed', chatId: input.chatId };
}

/** True when this chat is already the household thread Hale claimed. */
export async function familyOwnsLinqGroupChat(
  database: Database,
  familyId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return rows.some((row) => row.id === familyId && row.linqGroupChatId === chatId);
}

/**
 * One text into a Linq chat Hale is already in, plus its ledger row.
 * A send that throws is `not_sent` — the caller already decided the claim.
 */
export async function deliverLinqGroupNotice(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    text: string;
    templateKey: string;
    now: Date;
    fetch?: typeof fetch;
    send?: (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  },
): Promise<'sent' | 'not_sent'> {
  try {
    const sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text })
      : await sendLinqChatMessage({ chatId: input.chatId, text: input.text, fetch: input.fetch });
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: input.templateKey,
        providerMessageId: sent.providerMessageId,
        providerChatId: input.chatId,
        status: acceptedStatus('imessage'),
        sentAt: input.now,
      })
      .returning({ id: schema.channelMessages.id });
    const id = row?.id;
    if (!id) throw new Error('linq group notice: channel_messages insert returned no row');
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: id,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      { familyId: input.familyId, code },
      'linq group: the household-thread notice did not land',
    );
    return 'not_sent';
  }
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
