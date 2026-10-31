import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type CopyLanguage, type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import {
  addLinqParticipant,
  createLinqChat,
  outboundLineFrom,
  removeLinqParticipant,
  sendLinqChatMessage,
  setLinqChatBackground,
  updateLinqGroupChat,
} from '~/lib/channel/outbound-transport';
import { speak } from '~/lib/channel/spoken-line';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { linqGroupBackgroundEnabled } from './config';
import { haleContactImageUrl } from './contact-card';
import { type GroupLineClass, groupAudienceAllows } from './group-audience';
import { LinqSendError, listLinqParticipantHandles } from './transport';

/**
 * VIL-335 phase (b) — one household group, not a classmate-logistics brand.
 *
 * Hale, the enrolled parent, and their co-parent share the kids-year thread.
 * Every known handle maps through the phone blind index onto that same family.
 * An unknown number is acknowledged and not enrolled. The group chat id is
 * stored on the family so a later invite adds to it instead of opening another.
 */

/**
 * First bubble when Hale opens (or claims) the co-parent group. The model writes it
 * (VIL-506); a miss sends nothing. No URL: Linq rejects a link on the create-chat message.
 */
export function linqGroupOpenLine(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'linq_group_open', language });
}

/** DESIGN LOCK PENDING (Sloane). Group icon / name. Household dad+mom only, not a logistics brand. */
export const LINQ_GROUP_DISPLAY_NAME = "Kids' year";

/** The family's own language for a group line (Design #973: never an English default).
 * Local, not family-outbound's reader, because that module imports this one. */
async function groupLineLanguage(
  database: Database,
  familyId: string,
): Promise<ReplyLanguage | null> {
  const rows = await database
    .select({ id: schema.families.id, primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return acceptReplyLanguage(rows.find((row) => row.id === familyId)?.primaryLanguage);
}

/**
 * Sent in the 1:1 when Linq will not open the group (the co-parent has to have texted
 * the line first). The model writes it (VIL-506); a miss sends nothing.
 */
export function linqGroupUnreachableLine(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'linq_group_unreachable', language });
}

/**
 * An unclaimed group has no parent to name. Hale sends nothing about the
 * family into that thread. The claimed-group hold lives on group members.
 */

/**
 * Design locked (2026-09-24, #706). The whole message a parent sends in the
 * iMessage group they started, and nothing else. Hale claims that chat when
 * this arrives from an enrolled parent. A sentence that merely contains it
 * is not the trigger.
 */
export const LINQ_GROUP_TRIGGER_PHRASE: Record<CopyLanguage, string> = {
  en: 'this is our year',
  fr: 'cest notre annee',
};

/**
 * Design locked (2026-09-24, #706). Told in the 1:1 after the co-parent number.
 * Hale does not text that number and does not create the group.
 */
export function linqGroupMakeInstruction(
  line: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  const phrase =
    language === 'fr' || (language ?? '').startsWith('fr-')
      ? LINQ_GROUP_TRIGGER_PHRASE.fr
      : LINQ_GROUP_TRIGGER_PHRASE.en;
  return speak({
    purpose: 'linq_group_make',
    language,
    facts: { line, phrase },
    verbatim: [line, phrase],
  });
}

/**
 * Design locked (Sloane, 2026-09-25). The co-parent ask on Linq, one bubble.
 * `{line}` is Hale's number. No "text me their number", no invite promise.
 */
export function linqCoParentAsk(
  line: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  const phrase =
    language === 'fr' || (language ?? '').startsWith('fr-')
      ? LINQ_GROUP_TRIGGER_PHRASE.fr
      : LINQ_GROUP_TRIGGER_PHRASE.en;
  return speak({
    purpose: 'linq_coparent_ask',
    language,
    facts: { line, phrase },
    verbatim: [line, phrase],
  });
}

/**
 * Design locked (2026-09-24, #706). The trigger arrived in the 1:1. Hale does
 * not claim a group from that chat.
 */
export function linqGroupTriggerInOneToOne(
  line: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  const phrase =
    language === 'fr' || (language ?? '').startsWith('fr-')
      ? LINQ_GROUP_TRIGGER_PHRASE.fr
      : LINQ_GROUP_TRIGGER_PHRASE.en;
  return speak({
    purpose: 'linq_group_trigger_1to1',
    language,
    facts: { line, phrase },
    verbatim: [line, phrase],
  });
}

/** This chat cannot become the household thread. The model writes the sentence. */
export function linqGroupClaimRefused(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'linq_group_claim_refused', language });
}

/** Ack after a claim. The body is {@link linqGroupOpenLine}. */
export const LINQ_GROUP_CLAIMED_TEMPLATE_KEY = 'linq:group_claimed';
/** Refusal when this chat is already another household, or this household already has one. */
export const LINQ_GROUP_CLAIM_REFUSED_TEMPLATE_KEY = 'linq:group_claim_refused';
/** The trigger arrived in the 1:1. The body is {@link linqGroupTriggerInOneToOne}. */
export const LINQ_GROUP_TRIGGER_1TO1_TEMPLATE_KEY = 'linq:group_trigger_1to1';

/** Hale has no line to tell the parent to add. The model writes the sentence. */
export function linqGroupLineMissing(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'linq_group_line_missing', language });
}

/** A parent-facing rendering of Hale's E.164. NANP numbers read as a phone. */
export function formatLinqLineForParent(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return e164;
}

/** The trigger, or null. Trailing punctuation does not count as a different phrase. */
export function matchLinqGroupTrigger(body: string): CopyLanguage | null {
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
 * A send that throws is `not_sent` — the caller already decided the claim. A
 * household group whose audience takes no reply is `group_audience_refused`.
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
    /**
     * Audience class. A direct reply in the turn is `reply`; a proactive line
     * (e.g. a ride reminder) names its content class so an incomplete roster
     * holds it instead of treating it as a reply.
     */
    lineClass?: GroupLineClass;
  },
): Promise<'sent' | 'not_sent' | 'group_audience_refused'> {
  if (!(await groupAudienceAllows(database, input.chatId, input.lineClass ?? 'reply')).allowed) {
    return 'group_audience_refused';
  }
  let sent: { providerMessageId: string };
  try {
    sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text })
      : await sendLinqChatMessage({ chatId: input.chatId, text: input.text, fetch: input.fetch });
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      { familyId: input.familyId, code },
      'linq group: the household-thread notice did not land',
    );
    return 'not_sent';
  }
  // The text left. A ledger failure past this point is logged, never reported
  // as not_sent, so no caller replays a line the group already has.
  try {
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
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'linq group: notice sent but not ledgered',
    );
  }
  return 'sent';
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
        | 'unavailable'
        /** VIL-506: the model wrote no opening line, so no group was opened. */
        | 'no_line';
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
    const from = outboundLineFrom();
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

    const openText = await linqGroupOpenLine(await groupLineLanguage(database, args.familyId));
    if (!openText) {
      console.warn(
        { familyId: args.familyId },
        'linq group: no model-written opening line - group not opened, nothing sent',
      );
      return { status: 'skipped', reason: 'no_line' };
    }
    const created = await createLinqChat({
      from,
      to: [parent, coParent],
      text: openText,
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
    await setHouseholdGroupBackgroundOnce(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      chatId: created.chatId,
      fetch: args.fetch,
    });
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

/** The one colour Hale ever sets (VIL-478 Design lock: calm, readable). */
export const HOUSEHOLD_GROUP_BACKGROUND = 'ice' as const;

/**
 * VIL-478 — set the household group's background once, right after Hale creates
 * it. Never on a 1:1, a multi-family chat, or a group Hale did not just create
 * (those may already carry a wallpaper). Skips when a parent has already changed
 * it. Sends no bubble. A refusal or throw never blocks the group open.
 */
export async function setHouseholdGroupBackgroundOnce(
  database: Database,
  args: { familyId: string; parentUserId: string; chatId: string; fetch?: typeof fetch },
): Promise<'set' | 'off' | 'parent_owned' | 'refused'> {
  if (!linqGroupBackgroundEnabled()) return 'off';
  try {
    if (await parentOwnsGroupBackground(database, args.familyId)) return 'parent_owned';
    const result = await setLinqChatBackground({
      chatId: args.chatId,
      variant: HOUSEHOLD_GROUP_BACKGROUND,
      fetch: args.fetch,
    });
    if (result.status !== 'accepted') {
      console.warn(
        { familyId: args.familyId, status: result.status },
        'linq group: background not set',
      );
      return 'refused';
    }
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_group_background_set',
      targetTable: 'families',
      targetId: args.familyId,
      after: { variant: HOUSEHOLD_GROUP_BACKGROUND },
    });
    return 'set';
  } catch (err) {
    console.warn(
      { familyId: args.familyId, code: err instanceof LinqSendError ? err.code : 'unknown' },
      'linq group: background not set',
    );
    return 'refused';
  }
}

async function parentOwnsGroupBackground(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ familyId: schema.auditLog.familyId, actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'linq_group_background_parent_set'),
      ),
    );
  return rows.some(
    (row) => row.familyId === familyId && row.actionTaken === 'linq_group_background_parent_set',
  );
}

/**
 * VIL-478 — a `chat.background_updated` webhook. When a participant (not Hale's
 * own line, `actor_handle.is_me`) changed the household group's background, record
 * it so Hale never sets it over theirs. Hale's own echo is ignored. Sends nothing.
 */
export async function noteGroupBackgroundChange(
  database: Database,
  args: { chatId: string; isFromMe: boolean },
): Promise<'linq_background_mine' | 'linq_background_parent_noted' | 'linq_background_no_family'> {
  if (args.isFromMe) return 'linq_background_mine';
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, args.chatId));
  const familyId = rows.find((row) => row.linqGroupChatId === args.chatId)?.id;
  if (!familyId) return 'linq_background_no_family';
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'linq_group_background_parent_set',
    targetTable: 'families',
    targetId: familyId,
  });
  return 'linq_background_parent_noted';
}

async function tellParentTheGroupDidNotOpen(
  database: Database,
  args: { familyId: string; parentUserId: string; now: Date; fetch?: typeof fetch },
  chatId: string,
): Promise<void> {
  try {
    const text = await linqGroupUnreachableLine(await groupLineLanguage(database, args.familyId));
    if (!text) {
      console.warn(
        { familyId: args.familyId },
        'linq group: no model-written degrade line - nothing sent',
      );
      return;
    }
    const sent = await sendLinqChatMessage({
      chatId,
      text,
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

/**
 * Best-effort hold into a group Hale has not claimed. There is no parent to
 * address, so nothing is sent and nothing about a family is written.
 */
export async function holdUnknownGroupSender(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<'sent' | 'not_sent'> {
  console.warn(
    { chatId: input.chatId, outcome: 'not_sent', reason: 'parent_unresolved' },
    'linq group: stranger hold sends nothing about the family until a parent approves',
  );
  return 'not_sent';
}

/** Re-export so the co-parent flow and tests share one remove helper. */
export { removeLinqParticipant, listLinqParticipantHandles };
