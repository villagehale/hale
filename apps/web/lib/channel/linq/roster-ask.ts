import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { isParentRole } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqGroupOnboardingV2Enabled } from './config';
import type { RoleWordKey } from './group-onboarding-line-input';
import {
  type GroupLineOutcome,
  type GroupLineSend,
  type GroupOnboardingComposer,
  sendGroupOnboardingLine,
  sendUnledgeredGroupLine,
} from './group-onboarding-voice';
import { settleRosterStatus } from './roster-seat';

/**
 * Group onboarding v2 — the lines that ask who is who, and answer what was said.
 *
 * One `roster_ask` per roster names the parent Hale already knows and asks everyone else
 * to say, for themselves, who they are. Someone added later gets one `member_ask`. A
 * chat with no known parent gets one `no_family_yet` line and then silence. A seated
 * member gets one `role_confirmed`; a reply code cannot read gets one `role_reask`.
 * Every line is model-written; every outcome is named.
 */

type RosterRow = typeof schema.linqGroupRosters.$inferSelect;
type MemberRow = typeof schema.linqGroupRosterMembers.$inferSelect;

export interface RosterVoicePorts {
  now: Date;
  voice: GroupOnboardingComposer | undefined;
  send?: GroupLineSend;
}

const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];
const ASKABLE: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial'];
const OPEN: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial', 'confirmed'];

function delivered(notice: GroupLineOutcome): boolean {
  return notice.outcome === 'sent' || notice.outcome === 'already_sent';
}

export async function readRosterByChat(
  database: Database,
  chatId: string,
): Promise<RosterRow | null> {
  const [row] = await database
    .select()
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.chatId, chatId));
  return row ?? null;
}

export async function liveRosterMember(
  database: Database,
  rosterId: string,
  phoneHash: string,
): Promise<MemberRow | null> {
  const [row] = await database
    .select()
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, rosterId),
        eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneHash),
        notInArray(schema.linqGroupRosterMembers.status, GONE),
      ),
    );
  return row ?? null;
}

async function familyLanguage(database: Database, familyId: string): Promise<ReplyLanguage> {
  const [row] = await database
    .select({ primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

async function primaryParentId(database: Database, familyId: string): Promise<string | null> {
  const [row] = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    );
  return row?.userId ?? null;
}

export async function firstName(database: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const token = row?.name?.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

/** The parent the ask names: the primary parent when they are in the chat, else any known parent. */
async function knownParentName(
  database: Database,
  roster: RosterRow,
  primary: string | null,
): Promise<string | null> {
  const known = await database
    .select({ knownUserId: schema.linqGroupRosterMembers.knownUserId })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, roster.id),
        eq(schema.linqGroupRosterMembers.status, 'known_parent'),
      ),
    );
  const ids = known.map((row) => row.knownUserId).filter((id): id is string => id !== null);
  const pick = primary && ids.includes(primary) ? primary : (ids[0] ?? primary);
  return firstName(database, pick);
}

interface FamilyVoice {
  familyId: string;
  ledgerUserId: string;
  language: ReplyLanguage;
}

async function familyVoice(database: Database, roster: RosterRow): Promise<FamilyVoice | null> {
  if (!roster.familyId) return null;
  const ledgerUserId = await primaryParentId(database, roster.familyId);
  if (!ledgerUserId) {
    console.warn({ outcome: 'no_primary_parent' }, 'linq roster: no parent to ledger the line on');
    return null;
  }
  return {
    familyId: roster.familyId,
    ledgerUserId,
    language: await familyLanguage(database, roster.familyId),
  };
}

export type RosterAskOutcome =
  | { outcome: 'roster_asked'; notice: GroupLineOutcome }
  | { outcome: 'roster_ask_not_sent'; notice: GroupLineOutcome }
  | { outcome: 'roster_already_asked' }
  | { outcome: 'roster_not_askable'; status: schema.LinqGroupRosterStatus | null }
  | { outcome: 'no_primary_parent' };

/** One group line per roster: who Hale is, the parent it knows, and "who are you?" for the rest. */
export async function askRoster(
  database: Database,
  input: { chatId: string } & RosterVoicePorts,
): Promise<RosterAskOutcome> {
  const roster = await readRosterByChat(database, input.chatId);
  if (!roster?.familyId || !ASKABLE.includes(roster.status)) {
    return { outcome: 'roster_not_askable', status: roster?.status ?? null };
  }
  if (roster.askedAt) return { outcome: 'roster_already_asked' };
  const family = await familyVoice(database, roster);
  if (!family) return { outcome: 'no_primary_parent' };

  const live = await database
    .select({ status: schema.linqGroupRosterMembers.status })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, roster.id),
        notInArray(schema.linqGroupRosterMembers.status, GONE),
      ),
    );
  const notice = await sendGroupOnboardingLine(database, {
    ...family,
    chatId: input.chatId,
    request: {
      kind: 'roster_ask',
      knownParentName: await knownParentName(database, roster, family.ledgerUserId),
      rosterSize: live.length,
    },
    templateKey: 'linq:roster_ask',
    dedupeKey: `linq:roster_ask:${input.chatId}`,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
  if (!delivered(notice)) return { outcome: 'roster_ask_not_sent', notice };

  await database
    .update(schema.linqGroupRosters)
    .set({ askedAt: input.now, updatedAt: input.now })
    .where(and(eq(schema.linqGroupRosters.id, roster.id), isNull(schema.linqGroupRosters.askedAt)));
  const asked = await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'asked', askedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, roster.id),
        eq(schema.linqGroupRosterMembers.status, 'proposed'),
      ),
    )
    .returning({ id: schema.linqGroupRosterMembers.id });
  await database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: 'system',
    actionTaken: 'linq_group_roster_asked',
    targetTable: 'linq_group_rosters',
    targetId: roster.id,
    after: {
      asked: asked.length,
      source: notice.outcome === 'sent' ? notice.source : 'already_sent',
    },
  });
  return { outcome: 'roster_asked', notice };
}

export type NoFamilyOutcome =
  | { outcome: 'roster_no_family'; notice: GroupLineOutcome }
  | { outcome: 'roster_no_family_quiet' };

/**
 * A chat Hale was added to where it knows nobody: one line saying who Hale is and that
 * one of them should text it directly, then silence. Claimed on the roster row (there is
 * no family to ledger on); a line that does not go out releases the claim.
 */
export async function sayNoFamilyYet(
  database: Database,
  input: { chatId: string } & RosterVoicePorts,
): Promise<NoFamilyOutcome> {
  const claimed = await database
    .update(schema.linqGroupRosters)
    .set({ askedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqGroupRosters.chatId, input.chatId),
        eq(schema.linqGroupRosters.status, 'no_family'),
        isNull(schema.linqGroupRosters.askedAt),
      ),
    )
    .returning({ id: schema.linqGroupRosters.id });
  const rosterId = claimed[0]?.id;
  if (!rosterId) return { outcome: 'roster_no_family_quiet' };
  const notice = await sendUnledgeredGroupLine({
    chatId: input.chatId,
    request: { kind: 'no_family_yet' },
    language: 'en',
    voice: input.voice,
    send: input.send,
  });
  if (notice.outcome !== 'sent') {
    await database
      .update(schema.linqGroupRosters)
      .set({ askedAt: null, updatedAt: input.now })
      .where(eq(schema.linqGroupRosters.id, rosterId));
  }
  return { outcome: 'roster_no_family', notice };
}

export type MemberAskOutcome =
  | { outcome: 'member_asked'; notice: GroupLineOutcome }
  | { outcome: 'member_ask_not_sent'; notice: GroupLineOutcome }
  | { outcome: 'member_already' }
  | { outcome: 'member_known_parent' }
  | { outcome: 'group_member_refused'; reason: 'other_family' }
  | { outcome: 'roster_absent' }
  | { outcome: 'no_primary_parent' }
  | { outcome: 'ignored' };

/** Someone the roster did not ask yet: record them and ask them, once. Nobody is seated here. */
export async function askMember(
  database: Database,
  input: { chatId: string; phone: string } & RosterVoicePorts,
): Promise<MemberAskOutcome> {
  const phone = normalizePhoneE164(input.phone);
  if (!phone) return { outcome: 'ignored' };
  const roster = await readRosterByChat(database, input.chatId);
  if (!roster?.familyId || !OPEN.includes(roster.status)) return { outcome: 'roster_absent' };
  const hash = phoneBlindIndex(phone);

  let member = await liveRosterMember(database, roster.id, hash);
  if (member && member.status !== 'proposed') return { outcome: 'member_already' };

  const existing = await resolveVerifiedChannelByPhone(database, phone);
  if (existing && existing.familyId !== roster.familyId) {
    if (member) {
      await database
        .update(schema.linqGroupRosterMembers)
        .set({ status: 'refused', updatedAt: input.now })
        .where(eq(schema.linqGroupRosterMembers.id, member.id));
    } else {
      await database
        .insert(schema.linqGroupRosterMembers)
        .values({
          rosterId: roster.id,
          chatId: input.chatId,
          phoneE164Encrypted: encryptString(phone),
          phoneE164Hash: hash,
          status: 'refused',
        })
        .onConflictDoNothing();
    }
    await database.insert(schema.auditLog).values({
      familyId: roster.familyId,
      actor: 'system',
      actionTaken: 'linq_group_member_refused',
      targetTable: 'linq_group_rosters',
      targetId: roster.id,
      after: { reason: 'other_family' },
    });
    await settleRosterStatus(database, roster.id, input.now);
    return { outcome: 'group_member_refused', reason: 'other_family' };
  }

  if (!member) {
    const role = existing
      ? (
          await database
            .select({ role: schema.familyMembers.role })
            .from(schema.familyMembers)
            .where(
              and(
                eq(schema.familyMembers.familyId, roster.familyId),
                eq(schema.familyMembers.userId, existing.userId),
              ),
            )
        )[0]?.role
      : undefined;
    const knownParent = role !== undefined && isParentRole(role);
    await database
      .insert(schema.linqGroupRosterMembers)
      .values({
        rosterId: roster.id,
        chatId: input.chatId,
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: hash,
        knownUserId: knownParent ? existing?.userId : null,
        status: knownParent ? 'known_parent' : 'proposed',
      })
      .onConflictDoNothing();
    if (knownParent) return { outcome: 'member_known_parent' };
    member = await liveRosterMember(database, roster.id, hash);
    if (!member || member.status !== 'proposed') return { outcome: 'member_already' };
  }

  const family = await familyVoice(database, roster);
  if (!family) return { outcome: 'no_primary_parent' };
  const notice = await sendGroupOnboardingLine(database, {
    ...family,
    chatId: input.chatId,
    request: {
      kind: 'member_ask',
      knownParentName: await knownParentName(database, roster, family.ledgerUserId),
    },
    templateKey: 'linq:member_ask',
    dedupeKey: `linq:member_ask:${input.chatId}:${hash}`,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
  if (!delivered(notice)) return { outcome: 'member_ask_not_sent', notice };
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'asked', askedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqGroupRosterMembers.id, member.id),
        inArray(schema.linqGroupRosterMembers.status, ['proposed']),
      ),
    );
  await settleRosterStatus(database, roster.id, input.now);
  return { outcome: 'member_asked', notice };
}

/** The one acknowledgement after a seat: who they are, in their own word. Threaded to their reply. */
export async function acknowledgeRole(
  database: Database,
  input: {
    roster: RosterRow;
    member: MemberRow;
    role: RoleWordKey;
    name: string | null;
    reply: { messageId: string; text: string };
  } & RosterVoicePorts,
): Promise<GroupLineOutcome | { outcome: 'no_primary_parent' }> {
  const family = await familyVoice(database, input.roster);
  if (!family) return { outcome: 'no_primary_parent' };
  return sendGroupOnboardingLine(database, {
    ...family,
    chatId: input.roster.chatId,
    request: { kind: 'role_confirmed', name: input.name, role: input.role },
    parentWords: input.reply.text,
    replyTo: input.reply.messageId,
    templateKey: 'linq:role_confirmed',
    dedupeKey: `linq:role_confirmed:${input.roster.chatId}:${input.member.phoneE164Hash}`,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
}

/** One re-ask, threaded to the reply code could not read. The member is then `reasked`. */
export async function reaskRole(
  database: Database,
  input: {
    roster: RosterRow;
    member: MemberRow;
    reply: { messageId: string; text: string };
  } & RosterVoicePorts,
): Promise<GroupLineOutcome | { outcome: 'no_primary_parent' }> {
  const family = await familyVoice(database, input.roster);
  if (!family) return { outcome: 'no_primary_parent' };
  const notice = await sendGroupOnboardingLine(database, {
    ...family,
    chatId: input.roster.chatId,
    request: { kind: 'role_reask' },
    parentWords: input.reply.text,
    replyTo: input.reply.messageId,
    templateKey: 'linq:role_reask',
    dedupeKey: `linq:role_reask:${input.roster.chatId}:${input.member.phoneE164Hash}`,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
  if (!delivered(notice)) return notice;
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'reasked', updatedAt: input.now })
    .where(eq(schema.linqGroupRosterMembers.id, input.member.id));
  await database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: 'system',
    actionTaken: 'linq_group_role_reasked',
    targetTable: 'linq_group_roster_members',
    targetId: input.member.id,
  });
  return notice;
}

export type AskParticipantResult =
  | { outcome: 'flag_off' }
  | { outcome: 'group_unclaimed' }
  | MemberAskOutcome;

/**
 * Someone was added to a claimed group: ask them, once, who they are.
 * The add itself seats nobody. Flag off is `flag_off` so today's seat path can run.
 */
export async function askParticipantAdded(
  database: Database,
  input: {
    chatId: string;
    participantHandle: string;
    now: Date;
    voice: GroupOnboardingComposer | undefined;
    send?: GroupLineSend;
  },
): Promise<AskParticipantResult> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const phone = normalizePhoneE164(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  const [family] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, input.chatId))
    .limit(1);
  if (!family) return { outcome: 'group_unclaimed' };
  return askMember(database, {
    chatId: input.chatId,
    phone,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
}
