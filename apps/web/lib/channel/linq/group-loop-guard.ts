import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { and, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { SENT_STATUSES, isRealSendRow } from '~/lib/channel/ledger';
import { isParentRole } from '~/lib/channel/role-scope';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type OpsPage, type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { realHumanPhone } from './group-coparent';
import { presentHouseholds } from './multi-family';

/**
 * VIL-728 — Hale never ping-pongs with another bot in a group chat.
 *
 * Decided by behaviour in code, never by reading a word of the message:
 *
 * - WHO spoke. A person is someone seated in this chat ({@link isSeatedInChat}). Anyone
 *   else (an unknown number, an Apple ID email, a Hale customer who is not in this
 *   family's group) cannot end a run, so a bot cannot unlock the guard by speaking.
 * - HOW MUCH Hale said since. A run opens at the first unseated message after the last
 *   seated person spoke. Hale's own group sends since then are counted from the outbound
 *   ledger. A gap of {@link GROUP_LOOP_GUARD_RUN_GAP_MS} between unseated turns ends the
 *   run: that is too slow to be a loop, and it keeps a slow week from adding up.
 * - At {@link GROUP_LOOP_GUARD_CAP}, the chat goes quiet: Hale answers nobody unseated
 *   there, sends nothing and announces nothing, until a seated person speaks. The trip is
 *   audited and pages #ops once.
 *
 * A seated person is never held, so a group of people talking to each other and to Hale is
 * untouched. Behind `GROUP_LOOP_GUARD_ENABLED`, exactly `true`; off, nothing here runs.
 */

export function groupLoopGuardEnabled(): boolean {
  return isEnabled('group-loop-guard');
}

/** Hale group messages, with no seated person speaking, before the chat goes quiet. */
export const GROUP_LOOP_GUARD_CAP = 5;

/** The longest gap between unseated turns that still counts as one back-and-forth. */
export const GROUP_LOOP_GUARD_RUN_GAP_MS = 6 * 60 * 60 * 1000;

/** Every household this chat belongs to: the claimed group, its roster, a shared chat's
 * joined and present families. */
async function householdsInChat(database: Database, chatId: string): Promise<string[]> {
  const claimed = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, chatId));
  const rostered = await database
    .select({ familyId: schema.linqGroupRosters.familyId })
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.chatId, chatId));
  const joined = await database
    .select({ familyId: schema.linqMultiFamilyJoins.familyId })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(
        eq(schema.linqMultiFamilyJoins.chatId, chatId),
        isNull(schema.linqMultiFamilyJoins.leftAt),
      ),
    );
  const shared = await presentHouseholds(database, chatId, {
    includeStopped: true,
    includeLeft: false,
  });
  return [
    ...new Set([
      ...claimed.map((row) => row.id),
      ...rostered.flatMap((row) => (row.familyId ? [row.familyId] : [])),
      ...joined.map((row) => row.familyId),
      ...shared,
    ]),
  ];
}

/**
 * Whether this sender is seated in this chat: a live household or shared-group seat, a
 * known Hale family placed in the chat, or a parent of a family that holds it. A row with
 * no family is a number Hale only saw here, which is what a bot looks like. Never reads
 * the message.
 */
export async function isSeatedInChat(
  database: Database,
  chatId: string,
  senderHandle: string,
): Promise<boolean> {
  const phone = realHumanPhone(senderHandle);
  if (!phone) return false;
  const hash = phoneBlindIndex(phone);

  const household = schema.linqGroupMembers;
  const [householdSeat] = await database
    .select({ id: household.id })
    .from(household)
    .where(
      and(
        eq(household.chatId, chatId),
        eq(household.phoneE164Hash, hash),
        isNull(household.removedAt),
      ),
    )
    .limit(1);
  if (householdSeat) return true;

  const shared = schema.linqMultiFamilyMembers;
  const [sharedSeat] = await database
    .select({ id: shared.id })
    .from(shared)
    .where(and(eq(shared.chatId, chatId), eq(shared.phoneE164Hash, hash), isNull(shared.removedAt)))
    .limit(1);
  if (sharedSeat) return true;

  const people = schema.linqSharedGroupPeople;
  const [knownPerson] = await database
    .select({ id: people.id })
    .from(people)
    .where(
      and(eq(people.chatId, chatId), eq(people.phoneE164Hash, hash), isNotNull(people.familyId)),
    )
    .limit(1);
  if (knownPerson) return true;

  const channel = await resolveVerifiedChannelByPhone(database, phone);
  if (!channel) return false;
  const [member] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, channel.familyId),
        eq(schema.familyMembers.userId, channel.userId),
      ),
    )
    .limit(1);
  if (!member || !isParentRole(member.role)) return false;
  return (await householdsInChat(database, chatId)).includes(channel.familyId);
}

/**
 * Ledger rows that mark a reaction or a correction on a bubble already in the chat. They
 * are Hale's own template keys, not anything a person wrote, and none is a new message.
 */
const NOT_A_NEW_MESSAGE = ['linq:tapback', 'linq:sticker', 'linq:edit', 'linq:duty_tapback'];

/**
 * Hale's messages into this chat recorded at or after `since`, from the outbound ledger
 * every group send writes (provider chat id, direction out). `send_recorded_at` is the
 * database's own clock at the send, the same clock `since` was taken on. Most group lines
 * claim their row before the send, so a message still in flight already counts. Rows that
 * share one provider id are one message; a failed or covered row never left.
 */
export async function countHaleGroupSends(
  database: Database,
  chatId: string,
  since: Date,
): Promise<number> {
  const m = schema.channelMessages;
  const [row] = await database
    .select({
      sent: sql<number>`count(distinct coalesce(${m.providerMessageId}, ${m.id}::text))::int`,
    })
    .from(m)
    .where(
      and(
        eq(m.providerChatId, chatId),
        eq(m.direction, 'out'),
        inArray(m.status, [...SENT_STATUSES]),
        isRealSendRow(),
        gte(m.sendRecordedAt, since),
        or(isNull(m.templateKey), notInArray(m.templateKey, NOT_A_NEW_MESSAGE)),
      ),
    );
  return Number(row?.sent ?? 0);
}

export type GroupLoopGuardVerdict =
  /** The flag is off. Nothing was read or written. */
  | { verdict: 'off' }
  /** A tapback or vote in a chat no household holds: a 1:1, which this guard never touches. */
  | { verdict: 'not_group' }
  /** A seated person. `resumed` when their message reopened a quiet chat. */
  | { verdict: 'person'; resumed: boolean }
  /** Not seated, under the cap. The turn runs as it would without the guard. */
  | { verdict: 'open'; haleSince: number; cap: number }
  /**
   * Not seated, and the chat is quiet: Hale sends nothing for this message. `tripped` is
   * true for exactly one message, the one that took the chat quiet; `haleSince` is the count
   * that did it, and null on every later quiet message (nothing was counted).
   */
  | { verdict: 'quiet'; tripped: boolean; haleSince: number | null; cap: number };

async function unseatedTurn(
  database: Database,
  input: { chatId: string; at: Date },
): Promise<GroupLoopGuardVerdict> {
  const guards = schema.linqGroupLoopGuards;
  const at = input.at.toISOString();
  const runEndedBefore = new Date(input.at.getTime() - GROUP_LOOP_GUARD_RUN_GAP_MS).toISOString();
  const runEnded = sql`${guards.quietSince} is null and ${guards.lastTurnAt} < ${runEndedBefore}::timestamptz`;
  const [run] = await database
    .insert(guards)
    .values({ chatId: input.chatId, runStartedAt: input.at, lastTurnAt: input.at })
    .onConflictDoUpdate({
      target: guards.chatId,
      set: {
        runStartedAt: sql`case when ${runEnded} then ${at}::timestamptz else ${guards.runStartedAt} end`,
        countedFrom: sql`case when ${runEnded} then now() else ${guards.countedFrom} end`,
        lastTurnAt: sql`greatest(${guards.lastTurnAt}, ${at}::timestamptz)`,
      },
    })
    .returning({ countedFrom: guards.countedFrom, quietSince: guards.quietSince });
  if (!run) throw new Error('group loop guard: upsert returned no row');
  if (run.quietSince) {
    return { verdict: 'quiet', tripped: false, haleSince: null, cap: GROUP_LOOP_GUARD_CAP };
  }

  const haleSince = await countHaleGroupSends(database, input.chatId, run.countedFrom);
  if (haleSince < GROUP_LOOP_GUARD_CAP) {
    return { verdict: 'open', haleSince, cap: GROUP_LOOP_GUARD_CAP };
  }

  // Only one message takes the chat quiet, however many arrive at once: that one audits
  // and pages, and the rest are ordinary quiet messages.
  const took = await database
    .update(guards)
    .set({ quietSince: input.at })
    .where(and(eq(guards.chatId, input.chatId), isNull(guards.quietSince)))
    .returning({ chatId: guards.chatId });
  return { verdict: 'quiet', tripped: took.length > 0, haleSince, cap: GROUP_LOOP_GUARD_CAP };
}

/**
 * One group text, before any group path may answer it. `at` is the message's own time
 * (Linq's sent_at), so a redelivered message from a seated person cannot end a run that
 * started after they spoke. Writes the run state; sends nothing. Throws only when the
 * database does, and the door runs the turn as it would without the guard then.
 */
export async function checkGroupLoopGuard(
  database: Database,
  input: { chatId: string; senderHandle: string; at: Date },
): Promise<GroupLoopGuardVerdict> {
  if (!groupLoopGuardEnabled()) return { verdict: 'off' };
  if (await isSeatedInChat(database, input.chatId, input.senderHandle)) {
    const guards = schema.linqGroupLoopGuards;
    const closed = await database
      .delete(guards)
      .where(and(eq(guards.chatId, input.chatId), lte(guards.runStartedAt, input.at)))
      .returning({ quietSince: guards.quietSince });
    return { verdict: 'person', resumed: closed.some((row) => row.quietSince !== null) };
  }
  return unseatedTurn(database, input);
}

/**
 * A tapback or poll vote. These webhooks do not say whether the chat is a group, so one
 * counts only in a chat a household holds. A seated person's is never held and does not
 * end a run: a tapback is not someone speaking, and it carries no time of its own to tell
 * a fresh one from a redelivery.
 */
export async function checkGroupLoopGuardSignal(
  database: Database,
  input: { chatId: string; senderHandle: string; at: Date },
): Promise<GroupLoopGuardVerdict> {
  if (!groupLoopGuardEnabled()) return { verdict: 'off' };
  if (await isSeatedInChat(database, input.chatId, input.senderHandle)) {
    return { verdict: 'person', resumed: false };
  }
  if ((await householdsInChat(database, input.chatId)).length === 0) {
    return { verdict: 'not_group' };
  }
  return unseatedTurn(database, input);
}

export interface GroupLoopGuardPorts {
  /** Production pages #ops through {@link pageOps} (one page per hour, no ids). */
  page?: (page: OpsPage) => Promise<OpsPagerOutcome>;
}

export interface GroupLoopGuardTrip {
  /** Families that got the internal audit row: every household in the chat. */
  audited: number;
  /** A failed audit write is named here and in the log, never folded into `audited`. */
  auditFailed: boolean;
  page: OpsPagerOutcome | 'page_threw';
}

async function pageGuard(
  database: Database,
  opsPage: OpsPage,
  ports: GroupLoopGuardPorts,
): Promise<OpsPagerOutcome | 'page_threw'> {
  const page = ports.page ?? ((p: OpsPage) => pageOps(database, p));
  try {
    return await page(opsPage);
  } catch (err) {
    console.error(
      { outcome: 'group_loop_guard_page_threw', err: err instanceof Error ? err.name : 'unknown' },
      'group loop guard: the page call threw',
    );
    return 'page_threw';
  }
}

/**
 * The ops event for the one message that took a chat quiet: an internal audit row for each
 * household in the chat (the counts only, no handle, no words) and one #ops page. Never
 * throws: a failure here does not undo the quiet, it is named in the result and logged.
 */
export async function noteGroupLoopGuardTrip(
  database: Database,
  input: { chatId: string; haleSince: number; cap: number },
  ports: GroupLoopGuardPorts = {},
): Promise<GroupLoopGuardTrip> {
  let audited = 0;
  let auditFailed = false;
  try {
    const families = await householdsInChat(database, input.chatId);
    if (families.length > 0) {
      await database.insert(schema.auditLog).values(
        families.map((familyId) => ({
          familyId,
          actor: 'system',
          actionTaken: 'linq_group_loop_guard_quiet',
          targetTable: 'linq_group_loop_guards',
          targetId: input.chatId,
          after: { haleSince: input.haleSince, cap: input.cap },
        })),
      );
      audited = families.length;
    }
  } catch (err) {
    auditFailed = true;
    console.error(
      {
        outcome: 'group_loop_guard_audit_failed',
        err: err instanceof Error ? err.name : 'unknown',
      },
      'group loop guard: the chat is quiet but the audit row was not written',
    );
  }
  const page = await pageGuard(
    database,
    { site: 'group_loop_guard_tripped', facts: {}, count: input.haleSince },
    ports,
  );
  return { audited, auditFailed, page };
}

/** The guard could not read, so the turn ran unguarded. Never throws. */
export function noteGroupLoopGuardUnread(
  database: Database,
  ports: GroupLoopGuardPorts = {},
): Promise<OpsPagerOutcome | 'page_threw'> {
  return pageGuard(database, { site: 'group_loop_guard_unread', facts: {} }, ports);
}
