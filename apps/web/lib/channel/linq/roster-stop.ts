import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqGroupOnboardingV2Enabled } from './config';
import { noticeIfGroupQuiet } from './connect-link-1to1';
import { realHumanPhone } from './group-coparent';
import { sendGroupOnboardingLine } from './group-onboarding-voice';
import type { LinqInboundText } from './payload';
import { type EjectOutcome, ejectHouseholdGroup, ensureRoster, isUndefinedTable } from './roster';
import { familyLanguage, liveRosterMember, primaryParentId, readRosterByChat } from './roster-ask';
import { settleRosterStatus, unseatCaregiverSeat } from './roster-seat';
import type { RosterTurn, RosterTurnPorts } from './roster-turn';

/**
 * Group onboarding v2 — STOP, removal and eject in a family group.
 *
 * A STOP inside the group is about the group. From the primary parent it takes Hale out
 * of the group (the family goes back to 1:1). From anyone else it takes back the seat
 * the group gave them and leaves them on the roster as `declined`, so the group holds
 * (they are still reading it). Either way one acknowledgement is threaded to their
 * message, and nobody's 1:1 channel is revoked.
 *
 * Someone removed from the chat leaves the roster, and a seat the group granted them
 * goes with them: a caregiver's through `unseatCaregiverSeat`, a co-parent's through the
 * departure flow. Hale removed from the chat is the eject.
 */

const OPEN: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial', 'confirmed'];
const NOT_HANDLED: RosterTurn = { handled: false };

async function closeGroupSeat(
  database: Database,
  input: { chatId: string; phoneHash: string; now: Date },
): Promise<void> {
  await database
    .update(schema.linqGroupMembers)
    .set({ removedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, input.chatId),
        eq(schema.linqGroupMembers.phoneE164Hash, input.phoneHash),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );
}

/**
 * The eject, with the seats it ends: every caregiver seat this group granted is taken
 * back first (their consent was for this group). A co-parent stays a parent of the
 * family; only their group seat closes.
 */
export async function ejectWithGroupSeats(
  database: Database,
  input: { chatId: string; now: Date },
): Promise<EjectOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  let roster: Awaited<ReturnType<typeof readRosterByChat>>;
  try {
    roster = await readRosterByChat(database, input.chatId);
  } catch (err) {
    if (isUndefinedTable(err)) return { outcome: 'not_migrated' };
    throw err;
  }
  if (roster?.familyId) {
    const granted = await database
      .select({
        userId: schema.linqGroupRosterMembers.userId,
        confirmedRole: schema.linqGroupRosterMembers.confirmedRole,
      })
      .from(schema.linqGroupRosterMembers)
      .where(
        and(
          eq(schema.linqGroupRosterMembers.rosterId, roster.id),
          eq(schema.linqGroupRosterMembers.status, 'confirmed'),
        ),
      );
    for (const seat of granted) {
      if (!seat.userId || !seat.confirmedRole || seat.confirmedRole === 'co_parent') continue;
      await unseatCaregiverSeat(database, {
        familyId: roster.familyId,
        userId: seat.userId,
        chatId: input.chatId,
        via: 'group_ejected',
        now: input.now,
      });
    }
  }
  return ejectHouseholdGroup(database, input);
}

export async function stopInGroup(
  database: Database,
  message: LinqInboundText,
  ports: RosterTurnPorts,
): Promise<RosterTurn> {
  if (!linqGroupOnboardingV2Enabled()) return NOT_HANDLED;
  if (matchKeyword(message.text)?.keyword !== 'stop') return NOT_HANDLED;
  const phone = realHumanPhone(message.senderHandle);
  if (!phone) return NOT_HANDLED;

  const ensured = await ensureRoster(database, {
    chatId: message.chatId,
    now: ports.now,
    listHandles: ports.listHandles,
  });
  if (
    ensured.outcome === 'flag_off' ||
    ensured.outcome === 'not_migrated' ||
    ensured.outcome === 'roster_absent'
  ) {
    return NOT_HANDLED;
  }
  const roster = await readRosterByChat(database, message.chatId);
  if (!roster?.familyId || !OPEN.includes(roster.status)) return NOT_HANDLED;
  const familyId = roster.familyId;
  const primary = await primaryParentId(database, familyId);
  if (!primary) return NOT_HANDLED;

  const hash = phoneBlindIndex(phone);
  const channel = await resolveVerifiedChannelByPhone(database, phone);
  const own = channel?.familyId === familyId ? channel : null;
  if (own) await ports.recordInbound(message, { familyId, userId: own.userId });

  let outcome: 'group_stop_ejected' | 'group_stop_unseated';
  let role: string | null = null;
  if (own?.userId === primary) {
    await ejectWithGroupSeats(database, { chatId: message.chatId, now: ports.now });
    outcome = 'group_stop_ejected';
  } else {
    const member = await liveRosterMember(database, roster.id, hash);
    role = member?.confirmedRole ?? null;
    if (member?.status === 'confirmed' && member.userId && role && role !== 'co_parent') {
      await unseatCaregiverSeat(database, {
        familyId,
        userId: member.userId,
        chatId: message.chatId,
        via: 'group_stop',
        now: ports.now,
      });
    } else {
      await closeGroupSeat(database, { chatId: message.chatId, phoneHash: hash, now: ports.now });
      if (member) {
        await database
          .update(schema.linqGroupRosterMembers)
          .set({ status: 'declined', updatedAt: ports.now })
          .where(eq(schema.linqGroupRosterMembers.id, member.id));
      } else {
        await database
          .insert(schema.linqGroupRosterMembers)
          .values({
            rosterId: roster.id,
            chatId: message.chatId,
            phoneE164Encrypted: encryptString(phone),
            phoneE164Hash: hash,
            status: 'declined',
          })
          .onConflictDoNothing();
      }
      if (member?.status === 'confirmed' && role === 'co_parent') {
        await database.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'linq_group_member_unseated',
          targetTable: 'linq_group_roster_members',
          targetId: member.id,
          after: { role, via: 'group_stop' },
        });
      }
      await settleRosterStatus(database, roster.id, ports.now);
    }
    outcome = 'group_stop_unseated';
  }

  await database.insert(schema.auditLog).values({
    familyId,
    actor: own?.userId ?? 'system',
    actionTaken: 'linq_group_stop',
    targetTable: 'linq_group_rosters',
    targetId: roster.id,
    after: { outcome, role },
  });
  const ack = await sendGroupOnboardingLine(database, {
    familyId,
    ledgerUserId: primary,
    chatId: message.chatId,
    request: { kind: 'stop_ack' },
    language: await familyLanguage(database, familyId),
    replyTo: message.messageId,
    templateKey: 'linq:group_stop_ack',
    dedupeKey: `linq:group_stop_ack:${message.chatId}:${hash}`,
    now: ports.now,
    voice: ports.voice,
    send: ports.send,
  });
  const quiet =
    outcome === 'group_stop_unseated'
      ? await noticeIfGroupQuiet(database, {
          chatId: message.chatId,
          now: ports.now,
          voice: ports.voice,
          oneToOne: ports.oneToOne,
        })
      : null;
  console.info({ outcome, role, ack: ack.outcome }, 'linq roster: STOP in the group');
  return {
    handled: true,
    outcome,
    count: 'intake',
    body: { outcome, ack, ...(quiet ? { quiet: quiet.outcome } : {}) },
  };
}

export type RemoveParticipantOutcome =
  | { outcome: 'flag_off' }
  | { outcome: 'not_migrated' }
  | { outcome: 'ignored' }
  | { outcome: 'roster_member_absent' }
  | { outcome: 'roster_member_removed'; role: schema.LinqRosterConfirmedRole | null };

/** Someone else was taken out of the chat: off the roster, and out of any seat the group gave them. */
export async function removeRosterParticipant(
  database: Database,
  input: { chatId: string; participantHandle: string; now: Date },
): Promise<RemoveParticipantOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const phone = realHumanPhone(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  let roster: Awaited<ReturnType<typeof readRosterByChat>>;
  try {
    roster = await readRosterByChat(database, input.chatId);
  } catch (err) {
    if (isUndefinedTable(err)) return { outcome: 'not_migrated' };
    throw err;
  }
  if (!roster) return { outcome: 'roster_member_absent' };
  const hash = phoneBlindIndex(phone);
  const member = await liveRosterMember(database, roster.id, hash);
  if (!member) return { outcome: 'roster_member_absent' };

  const role = member.status === 'confirmed' ? member.confirmedRole : null;
  if (role && role !== 'co_parent' && member.userId && roster.familyId) {
    await unseatCaregiverSeat(database, {
      familyId: roster.familyId,
      userId: member.userId,
      chatId: input.chatId,
      via: 'participant_removed',
      now: input.now,
    });
    return { outcome: 'roster_member_removed', role };
  }

  if (role === 'co_parent' && member.userId && roster.familyId) {
    await departCoParent(database, {
      familyId: roster.familyId,
      actorUserId: member.userId,
      now: input.now,
    });
    await database.insert(schema.auditLog).values({
      familyId: roster.familyId,
      actor: 'system',
      actionTaken: 'linq_group_member_unseated',
      targetTable: 'linq_group_roster_members',
      targetId: member.id,
      after: { role, via: 'participant_removed' },
    });
  }
  await closeGroupSeat(database, { chatId: input.chatId, phoneHash: hash, now: input.now });
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'removed', updatedAt: input.now })
    .where(eq(schema.linqGroupRosterMembers.id, member.id));
  await settleRosterStatus(database, roster.id, input.now);
  return { outcome: 'roster_member_removed', role };
}
