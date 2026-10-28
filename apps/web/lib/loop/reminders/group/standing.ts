import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { householdTimezone } from '~/lib/channel/household-timezone';
import { readGroupMembership } from '~/lib/channel/linq/group-membership';
import { FLORIDA_OKLAHOMA_QUIET_START, quietStartForPhone } from '~/lib/channel/proactive/quiet';
import { isParentRole } from '~/lib/channel/role-scope';
import { loadSmsChannelState } from '~/lib/channels/sms-consent-core';
import { decryptString } from '~/lib/crypto/string-cipher';
import { loadLoopPrefsView } from '~/lib/loop/prefs';
import { loopSendEnabled } from '~/lib/loop/send';
import { QUIET_END, type QuietWindow, earliestQuietStart } from './policy';

/**
 * VIL-448 (T26) — who is in the chat and what a reminder may do for them, read the same
 * way when a reminder is set and when it fires. Phones are decrypted in memory only to
 * read an area code for quiet hours; none is logged or returned.
 */

export interface Seat {
  userId: string;
  phoneHash: string;
  phoneEncrypted: string;
  firstName: string | null;
}

export function firstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** Every live seat in the chat, with the first name Hale knows them by. */
export async function liveSeats(database: Database, chatId: string): Promise<Seat[]> {
  const rows = await database
    .select({
      userId: schema.linqGroupMembers.userId,
      phoneHash: schema.linqGroupMembers.phoneE164Hash,
      phoneEncrypted: schema.linqGroupMembers.phoneE164Encrypted,
      name: schema.users.name,
    })
    .from(schema.linqGroupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.linqGroupMembers.userId))
    .where(
      and(eq(schema.linqGroupMembers.chatId, chatId), isNull(schema.linqGroupMembers.removedAt)),
    );
  return rows.map((row) => ({
    userId: row.userId,
    phoneHash: row.phoneHash,
    phoneEncrypted: row.phoneEncrypted,
    firstName: firstName(row.name),
  }));
}

function seatPhone(seat: Pick<Seat, 'phoneEncrypted'>): string | null {
  try {
    return decryptString(seat.phoneEncrypted);
  } catch {
    return null;
  }
}

/**
 * The asker's own zone when Hale has one, else the household's. `users.timezone` is
 * NOT NULL with a `UTC` default (migration 0178), and no family Hale serves lives on
 * UTC, so that value means "never set".
 */
export async function askerTimeZone(
  database: Database,
  familyId: string,
  userId: string | null,
): Promise<string> {
  if (userId) {
    const [row] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (row?.timezone && row.timezone !== 'UTC') return row.timezone;
  }
  return householdTimezone(database, familyId);
}

/**
 * Quiet hours for a post everyone in the chat reads: the household's zone, from the
 * earliest quiet start of any seated phone (20:00 for a Florida or Oklahoma number,
 * 21:00 otherwise) to 08:00. A phone that cannot be read counts as the earliest.
 */
export async function groupQuiet(
  database: Database,
  familyId: string,
  seats: readonly Pick<Seat, 'phoneEncrypted'>[],
): Promise<{ timeZone: string; windows: QuietWindow[] }> {
  const timeZone = await householdTimezone(database, familyId);
  const starts = seats.map((seat) => {
    const phone = seatPhone(seat);
    return phone ? quietStartForPhone(phone) : FLORIDA_OKLAHOMA_QUIET_START;
  });
  return {
    timeZone,
    windows: [{ start: earliestQuietStart(starts, FLORIDA_OKLAHOMA_QUIET_START), end: QUIET_END }],
  };
}

/** Quiet hours for a 1:1 text: the phone's legal window and the parent's own setting. */
export async function directQuiet(
  database: Database,
  userId: string,
  seat: Pick<Seat, 'phoneEncrypted'> | null,
): Promise<QuietWindow[]> {
  const prefs = await loadLoopPrefsView(userId, database);
  const phone = seat ? seatPhone(seat) : null;
  return [
    { start: phone ? quietStartForPhone(phone) : FLORIDA_OKLAHOMA_QUIET_START, end: QUIET_END },
    { start: prefs.quietHoursStart, end: prefs.quietHoursEnd },
  ];
}

/**
 * Whether this person still counts as a Hale customer in the chat, by the same rule a
 * reminder was set with (decision 2026-10-21): only a customer's reminder goes 1:1.
 */
export async function seatedCustomer(
  database: Database,
  chatId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  const membership = await readGroupMembership(database, chatId);
  return (
    membership?.members.some((member) => member.userId === userId && member.haleCustomer) ?? false
  );
}

/**
 * Whether a 1:1 text can reach this person: a parent of this family, with live SMS
 * consent, reminders on, and the loop's sends switched on. Anyone else is reminded in
 * the group.
 */
export async function directReachable(
  database: Database,
  familyId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId || !loopSendEnabled()) return false;
  const [member] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
    )
    .limit(1);
  if (!member || !isParentRole(member.role)) return false;
  const prefs = await loadLoopPrefsView(userId, database);
  if (!prefs.catReminder) return false;
  const sms = await loadSmsChannelState(database, userId);
  return sms.enrolled;
}
