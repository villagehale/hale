import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqGroupOnboardingV2Enabled } from './config';
import { claimHouseholdLinqGroup } from './group';
import { realHumanPhone } from './group-coparent';
import type { LinqSignal } from './payload';
import { listLinqParticipantHandles } from './transport';

/**
 * Group onboarding v2 — who is in a group Hale was added to.
 *
 * Hale reads the chat's members (from `chat.created`, or GET /chats/{id}), matches each
 * phone against the verified parents it already knows, and records the result in
 * `linq_group_rosters` / `linq_group_roster_members`. One family among the matched
 * parents claims the chat and the rest of the chat is `proposed`; no matched parent is
 * `no_family`; two families is `mixed_family` (multi-family stays dark). Nobody is seated
 * here and nothing is sent: a seat is written only on the person's own reply, and the
 * lines that ask are a later step. Every path returns a named outcome.
 *
 * The roster tables are read on the group hot path. Until migration 0158 reaches the
 * database, every entry point answers `not_migrated` (42P01) rather than failing the
 * webhook.
 */

type RosterStatus = schema.LinqGroupRosterStatus;
type MemberStatus = schema.LinqRosterMemberStatus;
type RosterRow = typeof schema.linqGroupRosters.$inferSelect;

export type ListChatHandles = (input: {
  chatId: string;
}) => ReturnType<typeof listLinqParticipantHandles>;

export type RosterFetchFailure = 'not_configured' | 'unreachable' | 'refused';

export type RosterSettled =
  | {
      outcome: 'roster_matched';
      status: 'roles_proposed' | 'confirmed';
      familyId: string;
      knownParents: number;
      confirmed: number;
      proposed: number;
      skippedHandles: number;
    }
  | { outcome: 'roster_no_family'; skippedHandles: number }
  | { outcome: 'roster_mixed_family'; skippedHandles: number }
  | { outcome: 'roster_chat_claimed_elsewhere' }
  | { outcome: 'roster_family_has_other_chat'; familyId: string };

export type GroupRosterOutcome =
  | { outcome: 'flag_off' }
  | { outcome: 'not_migrated' }
  | { outcome: 'roster_already'; status: RosterStatus }
  | { outcome: 'roster_fetch_failed'; reason: RosterFetchFailure }
  | { outcome: 'roster_not_group' }
  | RosterSettled;

/**
 * Statuses a new add may (re)build from. Everything else is settled. A `refused` roster is
 * claimed again through the same IS NULL guard, so a chat that is still blocked is refused
 * again and nothing is sent.
 */
const REBUILDABLE: readonly RosterStatus[] = ['roster_pending', 'ejected', 'refused'];
const GONE: MemberStatus[] = ['left', 'removed'];
const TERMINAL: readonly MemberStatus[] = [
  'known_parent',
  'confirmed',
  'declined',
  'not_family',
  'refused',
  'left',
  'removed',
];

function isUndefinedTable(err: unknown): boolean {
  const fields = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return fields?.code === '42P01' || fields?.cause?.code === '42P01';
}

function notMigrated(): { outcome: 'not_migrated' } {
  console.warn({ outcome: 'not_migrated' }, 'linq roster: roster tables missing');
  return { outcome: 'not_migrated' };
}

async function readRoster(
  database: Database,
  chatId: string,
): Promise<RosterRow | null | 'not_migrated'> {
  try {
    const [row] = await database
      .select()
      .from(schema.linqGroupRosters)
      .where(eq(schema.linqGroupRosters.chatId, chatId));
    return row ?? null;
  } catch (err) {
    if (isUndefinedTable(err)) return 'not_migrated';
    throw err;
  }
}

/** The signal that means Hale is now in a group: its own add, or a new group chat. */
export function groupRosterTrigger(
  signal: LinqSignal,
): { chatId: string; source: 'added_to_existing'; handles?: string[] } | null {
  if (!signal.chatId) return null;
  if (signal.event === 'participant.added' && signal.isFromMe) {
    return { chatId: signal.chatId, source: 'added_to_existing' };
  }
  if (signal.event === 'chat.created' && signal.isGroup === true) {
    return { chatId: signal.chatId, source: 'added_to_existing', handles: signal.handles };
  }
  return null;
}

/**
 * Build the roster for a chat Hale is now in. Idempotent per chat: a second trigger for
 * the same chat (the `participant.added` and `chat.created` pair) is `roster_already`.
 * `handles` skips the GET when the webhook already listed the members. A failed GET
 * leaves the roster `roster_pending`, and the next call fetches again.
 */
export async function startGroupRoster(
  database: Database,
  input: {
    chatId: string;
    source: schema.LinqGroupRosterSource;
    familyId?: string;
    handles?: readonly string[];
    now: Date;
    listHandles?: ListChatHandles;
  },
): Promise<GroupRosterOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const existing = await readRoster(database, input.chatId);
  if (existing === 'not_migrated') return notMigrated();
  if (existing && !REBUILDABLE.includes(existing.status)) {
    return { outcome: 'roster_already', status: existing.status };
  }

  let rosterId = existing?.id;
  if (!rosterId) {
    const [inserted] = await database
      .insert(schema.linqGroupRosters)
      .values({
        chatId: input.chatId,
        familyId: input.familyId ?? null,
        source: input.source,
        status: 'roster_pending',
      })
      .onConflictDoNothing()
      .returning({ id: schema.linqGroupRosters.id });
    if (!inserted) {
      const winner = await readRoster(database, input.chatId);
      if (winner === 'not_migrated') return notMigrated();
      return { outcome: 'roster_already', status: winner?.status ?? 'roster_pending' };
    }
    rosterId = inserted.id;
  }

  let handles: readonly string[];
  if (input.handles && input.handles.length > 0) {
    handles = input.handles;
  } else {
    const listed = await (input.listHandles ?? listLinqParticipantHandles)({
      chatId: input.chatId,
    });
    if (listed.status !== 'ok') {
      await database
        .update(schema.linqGroupRosters)
        .set({ status: 'roster_pending', updatedAt: input.now })
        .where(eq(schema.linqGroupRosters.id, rosterId));
      console.warn(
        { outcome: 'roster_fetch_failed', reason: listed.status },
        'linq roster: chat members could not be read',
      );
      return { outcome: 'roster_fetch_failed', reason: listed.status };
    }
    if (listed.isGroup === false) {
      await database
        .update(schema.linqGroupRosters)
        .set({ status: 'not_group', familyId: null, updatedAt: input.now })
        .where(eq(schema.linqGroupRosters.id, rosterId));
      console.warn({ outcome: 'roster_not_group' }, 'linq roster: chat is not a group');
      return { outcome: 'roster_not_group' };
    }
    handles = listed.handles;
  }

  const phones: string[] = [];
  for (const handle of handles) {
    const phone = realHumanPhone(handle);
    if (phone && !phones.includes(phone)) phones.push(phone);
  }
  return settleRoster(database, {
    rosterId,
    chatId: input.chatId,
    source: input.source,
    familyHint: input.familyId ?? null,
    members: phones.map((phone) => ({
      hash: phoneBlindIndex(phone),
      encrypted: encryptString(phone),
    })),
    skippedHandles: handles.length - phones.length,
    now: input.now,
  });
}

/**
 * The roster step on an inbound in a group. A `roster_pending` roster fetches again, and
 * so does a `refused` one once nothing blocks the claim any more (Hale stays in a refused
 * chat, so no new add will come); a chat a family already claimed with no roster yet is
 * backfilled (its seated co-parent confirmed, not re-asked). An unclaimed chat with no
 * roster is left to the triggers.
 */
export async function ensureRoster(
  database: Database,
  input: { chatId: string; now: Date; listHandles?: ListChatHandles },
): Promise<GroupRosterOutcome | { outcome: 'roster_absent' }> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const existing = await readRoster(database, input.chatId);
  if (existing === 'not_migrated') return notMigrated();
  if (existing) {
    const retry =
      existing.status === 'roster_pending' ||
      (existing.status === 'refused' && !(await claimStillBlocked(database, existing)));
    if (!retry) return { outcome: 'roster_already', status: existing.status };
    return startGroupRoster(database, {
      chatId: input.chatId,
      source: existing.source,
      familyId: existing.familyId ?? undefined,
      now: input.now,
      listHandles: input.listHandles,
    });
  }
  const [holder] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, input.chatId));
  if (!holder) return { outcome: 'roster_absent' };
  return startGroupRoster(database, {
    chatId: input.chatId,
    source: 'backfill',
    familyId: holder.id,
    now: input.now,
    listHandles: input.listHandles,
  });
}

/** A family holds this chat, or the refused roster's family still holds another one. */
async function claimStillBlocked(database: Database, roster: RosterRow): Promise<boolean> {
  const holdsThisChat = eq(schema.families.linqGroupChatId, roster.chatId);
  const [blocker] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(
      roster.familyId
        ? or(
            holdsThisChat,
            and(
              eq(schema.families.id, roster.familyId),
              isNotNull(schema.families.linqGroupChatId),
            ),
          )
        : holdsThisChat,
    )
    .limit(1);
  return blocker !== undefined;
}

interface HandleMatch {
  phoneHash: string;
  userId: string;
  familyId: string;
  role: string;
}

/**
 * The verified parents among these phones: a live, verified `parent_channels` row whose
 * user holds a parent role in that channel's family. A caregiver Hale knows is not a
 * parent match. Returned by blind index; phones never leave the caller.
 */
export async function matchHandlesToFamilies(
  database: Database,
  phones: readonly string[],
): Promise<HandleMatch[]> {
  return matchHashes(
    database,
    phones.map((phone) => phoneBlindIndex(phone)),
  );
}

async function matchHashes(database: Database, hashes: readonly string[]): Promise<HandleMatch[]> {
  if (hashes.length === 0) return [];
  const rows = await database
    .select({
      phoneHash: schema.parentChannels.phoneE164Hash,
      userId: schema.parentChannels.userId,
      familyId: schema.parentChannels.familyId,
      role: schema.familyMembers.role,
    })
    .from(schema.parentChannels)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.userId, schema.parentChannels.userId),
        eq(schema.familyMembers.familyId, schema.parentChannels.familyId),
      ),
    )
    .where(
      and(
        inArray(schema.parentChannels.phoneE164Hash, [...hashes]),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    );
  return rows.flatMap((row) =>
    row.phoneHash && isParentRole(row.role) ? [{ ...row, phoneHash: row.phoneHash }] : [],
  );
}

function rosterStatusFor(statuses: readonly MemberStatus[]): 'roles_proposed' | 'confirmed' {
  return statuses.every((status) => TERMINAL.includes(status)) ? 'confirmed' : 'roles_proposed';
}

/**
 * Match, decide, and write: members, roster status, the claim, one audit row per family
 * the roster touched. One transaction, so a roster is never half-settled.
 */
async function settleRoster(
  database: Database,
  input: {
    rosterId: string;
    chatId: string;
    source: schema.LinqGroupRosterSource;
    familyHint: string | null;
    /** One per real phone in the chat; Hale's line and non-phone handles already dropped. */
    members: ReadonlyArray<{ hash: string; encrypted: string }>;
    skippedHandles: number;
    now: Date;
  },
): Promise<RosterSettled> {
  const matches = await matchHashes(
    database,
    input.members.map((member) => member.hash),
  );
  const families = new Set(matches.map((match) => match.familyId));
  if (input.familyHint) families.add(input.familyHint);
  const decided = families.size === 1 ? [...families][0] : null;

  const statusOf = (hash: string): { status: MemberStatus; match: HandleMatch | null } => {
    const match = matches.find((m) => m.phoneHash === hash) ?? null;
    if (!match) return { status: 'proposed', match: null };
    if (input.source === 'backfill' && match.familyId === decided && match.role === 'co_parent') {
      return { status: 'confirmed', match };
    }
    return { status: 'known_parent', match };
  };
  const planned = input.members.map((member) => ({ ...member, ...statusOf(member.hash) }));

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;

    const live = await tx
      .select({
        id: schema.linqGroupRosterMembers.id,
        phoneE164Hash: schema.linqGroupRosterMembers.phoneE164Hash,
      })
      .from(schema.linqGroupRosterMembers)
      .where(
        and(
          eq(schema.linqGroupRosterMembers.rosterId, input.rosterId),
          notInArray(schema.linqGroupRosterMembers.status, GONE),
        ),
      );
    for (const member of planned) {
      const fields = {
        status: member.status,
        knownUserId: member.match?.userId ?? null,
        userId: member.status === 'confirmed' ? (member.match?.userId ?? null) : null,
        confirmedRole: member.status === 'confirmed' ? ('co_parent' as const) : null,
        confirmedAt: member.status === 'confirmed' ? input.now : null,
        updatedAt: input.now,
      };
      const row = live.find((m) => m.phoneE164Hash === member.hash);
      if (row) {
        await tx
          .update(schema.linqGroupRosterMembers)
          .set(fields)
          .where(eq(schema.linqGroupRosterMembers.id, row.id));
      } else {
        await tx
          .insert(schema.linqGroupRosterMembers)
          .values({
            rosterId: input.rosterId,
            chatId: input.chatId,
            phoneE164Encrypted: member.encrypted,
            phoneE164Hash: member.hash,
            ...fields,
          })
          .onConflictDoNothing();
      }
    }

    const counts = {
      knownParents: planned.filter((m) => m.status === 'known_parent').length,
      confirmed: planned.filter((m) => m.status === 'confirmed').length,
      proposed: planned.filter((m) => m.status === 'proposed').length,
    };
    let settled: RosterSettled;
    let rosterStatus: RosterStatus;
    let rosterFamily: string | null = null;
    if (families.size === 0) {
      settled = { outcome: 'roster_no_family', skippedHandles: input.skippedHandles };
      rosterStatus = 'no_family';
    } else if (!decided) {
      settled = { outcome: 'roster_mixed_family', skippedHandles: input.skippedHandles };
      rosterStatus = 'mixed_family';
    } else {
      const claimant =
        planned.find((m) => m.match?.familyId === decided && m.match.role === 'primary_parent')
          ?.match ?? planned.find((m) => m.match?.familyId === decided)?.match;
      const claim = await claimHouseholdLinqGroup(tx, {
        familyId: decided,
        parentUserId: claimant?.userId ?? 'system',
        chatId: input.chatId,
        now: input.now,
      });
      if (claim.status === 'family_missing') {
        throw new Error('linq roster: matched family vanished mid-settle');
      }
      if (claim.status === 'claimed_by_other_family') {
        settled = { outcome: 'roster_chat_claimed_elsewhere' };
        rosterStatus = 'refused';
      } else if (claim.status === 'already_other_chat') {
        settled = { outcome: 'roster_family_has_other_chat', familyId: decided };
        rosterStatus = 'refused';
        rosterFamily = decided;
      } else {
        rosterStatus = rosterStatusFor(planned.map((m) => m.status));
        settled = {
          outcome: 'roster_matched',
          status: rosterStatus,
          familyId: decided,
          ...counts,
          skippedHandles: input.skippedHandles,
        };
        rosterFamily = decided;
      }
    }

    await tx
      .update(schema.linqGroupRosters)
      .set({
        status: rosterStatus,
        familyId: rosterFamily,
        memberCount: planned.length,
        rosterFetchedAt: input.now,
        confirmedAt: rosterStatus === 'confirmed' ? input.now : null,
        ejectedAt: null,
        updatedAt: input.now,
      })
      .where(eq(schema.linqGroupRosters.id, input.rosterId));

    const audited =
      settled.outcome === 'roster_chat_claimed_elsewhere'
        ? []
        : settled.outcome === 'roster_mixed_family'
          ? [...families]
          : rosterFamily
            ? [rosterFamily]
            : [];
    for (const familyId of audited) {
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'linq_group_roster_fetched',
        targetTable: 'linq_group_rosters',
        targetId: input.rosterId,
        after: {
          status: rosterStatus,
          source: input.source,
          memberCount: planned.length,
          ...counts,
          skippedHandles: input.skippedHandles,
        },
      });
    }
    console.info({ outcome: settled.outcome, status: rosterStatus }, 'linq roster: settled');
    return settled;
  });
}

/**
 * A member of a waiting `no_family` roster just finished 1:1 intake: match that roster
 * again. One family now is `roster_matched` (and the chat is claimed); otherwise the
 * roster keeps waiting under its named outcome. An empty list means this phone is in no
 * waiting roster.
 */
export async function attachRosterToFamily(
  database: Database,
  input: { phoneE164: string; now: Date },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'not_migrated' }
  | { outcome: 'attached'; rosters: Array<{ chatId: string } & RosterSettled> }
> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const canonical = normalizePhoneE164(input.phoneE164);
  if (!canonical) return { outcome: 'attached', rosters: [] };
  let waiting: Array<{ id: string; chatId: string; source: schema.LinqGroupRosterSource }>;
  try {
    waiting = await database
      .selectDistinct({
        id: schema.linqGroupRosters.id,
        chatId: schema.linqGroupRosters.chatId,
        source: schema.linqGroupRosters.source,
      })
      .from(schema.linqGroupRosters)
      .innerJoin(
        schema.linqGroupRosterMembers,
        eq(schema.linqGroupRosterMembers.rosterId, schema.linqGroupRosters.id),
      )
      .where(
        and(
          eq(schema.linqGroupRosters.status, 'no_family'),
          eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(canonical)),
          notInArray(schema.linqGroupRosterMembers.status, GONE),
        ),
      );
  } catch (err) {
    if (isUndefinedTable(err)) return notMigrated();
    throw err;
  }

  const rosters: Array<{ chatId: string } & RosterSettled> = [];
  for (const roster of waiting) {
    const members = await database
      .select({
        phoneE164Encrypted: schema.linqGroupRosterMembers.phoneE164Encrypted,
        phoneE164Hash: schema.linqGroupRosterMembers.phoneE164Hash,
      })
      .from(schema.linqGroupRosterMembers)
      .where(
        and(
          eq(schema.linqGroupRosterMembers.rosterId, roster.id),
          notInArray(schema.linqGroupRosterMembers.status, GONE),
        ),
      );
    const settled = await settleRoster(database, {
      rosterId: roster.id,
      chatId: roster.chatId,
      source: roster.source,
      familyHint: null,
      members: members.map((member) => ({
        hash: member.phoneE164Hash,
        encrypted: member.phoneE164Encrypted,
      })),
      skippedHandles: 0,
      now: input.now,
    });
    rosters.push({ chatId: roster.chatId, ...settled });
  }
  return { outcome: 'attached', rosters };
}

export type EjectOutcome =
  | { outcome: 'flag_off' }
  | { outcome: 'not_migrated' }
  | { outcome: 'not_claimed' }
  | {
      outcome: 'ejected';
      familyId: string | null;
      /** Live `linq_group_members` seats in this chat closed. */
      seatsRemoved: number;
      /**
       * Family seats a member gained through this group's roster, left in place. Taking
       * them away (co-parent departure, caregiver unseat) is the removal step's job.
       */
      familySeatsKept: number;
    };

/**
 * Hale was removed from the group (or its primary parent stopped it). The family goes
 * back to 1:1: the chat id is released, the roster is `ejected`, every live member row
 * is `removed`, and every live group seat in the chat is closed. Sends nothing.
 */
export async function ejectHouseholdGroup(
  database: Database,
  input: { chatId: string; now: Date },
): Promise<EjectOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const roster = await readRoster(database, input.chatId);
  if (roster === 'not_migrated') return notMigrated();

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const released = await tx
      .update(schema.families)
      .set({ linqGroupChatId: null, updatedAt: input.now })
      .where(eq(schema.families.linqGroupChatId, input.chatId))
      .returning({ id: schema.families.id });
    const familyId = released[0]?.id ?? null;
    if (!familyId && (!roster || roster.status === 'ejected')) return { outcome: 'not_claimed' };

    const seats = await tx
      .update(schema.linqGroupMembers)
      .set({ removedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.linqGroupMembers.chatId, input.chatId),
          isNull(schema.linqGroupMembers.removedAt),
        ),
      )
      .returning({ id: schema.linqGroupMembers.id });

    let familySeatsKept = 0;
    if (roster) {
      const kept = await tx
        .update(schema.linqGroupRosterMembers)
        .set({ status: 'removed', updatedAt: input.now })
        .where(
          and(
            eq(schema.linqGroupRosterMembers.rosterId, roster.id),
            notInArray(schema.linqGroupRosterMembers.status, GONE),
          ),
        )
        .returning({ userId: schema.linqGroupRosterMembers.userId });
      familySeatsKept = kept.filter((row) => row.userId !== null).length;
      await tx
        .update(schema.linqGroupRosters)
        .set({ status: 'ejected', ejectedAt: input.now, updatedAt: input.now })
        .where(eq(schema.linqGroupRosters.id, roster.id));
    }

    if (familyId) {
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'linq_group_ejected',
        targetTable: 'families',
        targetId: familyId,
        after: { seatsRemoved: seats.length, familySeatsKept },
      });
    }
    console.info(
      { outcome: 'ejected', seatsRemoved: seats.length, familySeatsKept },
      'linq roster: group ejected',
    );
    return { outcome: 'ejected', familyId, seatsRemoved: seats.length, familySeatsKept };
  });
}
