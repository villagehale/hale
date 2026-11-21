import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { SENT_STATUSES, isRealSendRow } from '~/lib/channel/ledger';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { type OpsPage, type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { realHumanPhone } from './group-coparent';
import { presentHouseholds } from './multi-family';

/**
 * VIL-728 — Hale never ping-pongs with another bot in a group chat.
 *
 * Decided by behaviour in code, never by reading a word of the message:
 *
 * - WHO spoke. A sender is a person when their number resolves to a verified Hale channel:
 *   a parent, a co-parent, or a member the roster seated on their own reply (seating
 *   verifies the number). It is the same predicate the household door answers family by.
 *   Anyone else (an unknown number, an Apple ID email, Hale's own line) is unverified.
 * - HOW MUCH Hale said since. A run opens at the first unverified-sender message after the
 *   last person spoke. Hale's own group sends since then, within the last
 *   {@link GROUP_LOOP_GUARD_WINDOW_MS}, are counted from the outbound ledger.
 * - At the cap, the chat goes quiet: Hale answers no unverified sender there, sends nothing
 *   and announces nothing, until a person speaks. The trip is audited and pages #ops once.
 *
 * A person is never held by this guard, so a group of people talking to each other and to
 * Hale is untouched. The cap is a setting ({@link groupLoopGuardCap}), not a phrase anyone
 * reads. Behind `GROUP_LOOP_GUARD_ENABLED`, exactly `true`; off, nothing here runs.
 */

export function groupLoopGuardEnabled(): boolean {
  return isEnabled('group-loop-guard');
}

/** Env name of the cap. Config, not a flag: the flag turns the guard on, this tunes it. */
export const GROUP_LOOP_GUARD_CAP_ENV = 'GROUP_LOOP_GUARD_CAP';

/** Hale group messages, with no person speaking, before the chat goes quiet. */
export const GROUP_LOOP_GUARD_CAP_DEFAULT = 5;

/** The largest cap the setting accepts. Above it the guard would not be a guard. */
export const GROUP_LOOP_GUARD_CAP_MAX = 50;

/**
 * Only Hale's sends this recent count toward the cap. A bot loop is a rapid back-and-forth
 * (seconds a turn), so this is far wider than any loop, and it keeps a slow day of replies
 * to people Hale has not verified, or reminders sent into a quiet run, from adding up.
 */
export const GROUP_LOOP_GUARD_WINDOW_MS = 30 * 60 * 1000;

/**
 * The cap. Unset is the default. Anything but a whole number from 1 to
 * {@link GROUP_LOOP_GUARD_CAP_MAX}, written plainly, is the default and is logged.
 */
export function groupLoopGuardCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env[GROUP_LOOP_GUARD_CAP_ENV];
  if (raw === undefined || raw.trim() === '') return GROUP_LOOP_GUARD_CAP_DEFAULT;
  const value = Number(raw.trim());
  if (
    !Number.isInteger(value) ||
    String(value) !== raw.trim() ||
    value < 1 ||
    value > GROUP_LOOP_GUARD_CAP_MAX
  ) {
    console.warn(
      { outcome: 'group_loop_guard_cap_invalid', default: GROUP_LOOP_GUARD_CAP_DEFAULT },
      'group loop guard: GROUP_LOOP_GUARD_CAP is not a whole number from 1 to 50; using the default',
    );
    return GROUP_LOOP_GUARD_CAP_DEFAULT;
  }
  return value;
}

export type GroupSpeaker = 'person' | 'unverified';

/** Whether the sender's number is a verified Hale channel. Never reads the message. */
export async function groupSpeakerOf(
  database: Database,
  senderHandle: string,
): Promise<GroupSpeaker> {
  const phone = realHumanPhone(senderHandle);
  if (!phone) return 'unverified';
  return (await resolveVerifiedChannelByPhone(database, phone)) ? 'person' : 'unverified';
}

/**
 * Ledger rows that mark a reaction or a correction on a bubble already in the chat. They
 * are Hale's own template keys, not anything a person wrote, and none is a new message.
 */
const NOT_A_NEW_MESSAGE = ['linq:tapback', 'linq:sticker', 'linq:edit', 'linq:duty_tapback'];

/**
 * Hale's messages into this chat that left at or after `since`, from the outbound ledger
 * every group send writes (provider chat id, direction out, its send time). Most group
 * lines claim their row before the send, so a message still in flight already counts.
 * Rows that share one provider id are one message; a failed or covered row never left.
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
        isNotNull(m.sentAt),
        gte(m.sentAt, since),
        or(isNull(m.templateKey), notInArray(m.templateKey, NOT_A_NEW_MESSAGE)),
      ),
    );
  return Number(row?.sent ?? 0);
}

export type GroupLoopGuardVerdict =
  /** The flag is off. Nothing was read or written. */
  | { verdict: 'off' }
  /** A person spoke. Any open run is closed; `resumed` when the chat had been quiet. */
  | { verdict: 'person'; resumed: boolean }
  /** Not a person, under the cap. The turn runs as it would without the guard. */
  | { verdict: 'open'; haleSince: number; cap: number }
  /**
   * Not a person, and the chat is quiet: Hale sends nothing for this message. `tripped` is
   * true for exactly one message, the one that took the chat quiet; `haleSince` is the count
   * that did it, and null on every later quiet message (nothing was counted).
   */
  | { verdict: 'quiet'; tripped: boolean; haleSince: number | null; cap: number };

/**
 * One group message, before any group path may answer it. Writes the run state; sends
 * nothing. Throws only when the database does, and the door runs the turn unguarded then.
 */
export async function checkGroupLoopGuard(
  database: Database,
  input: { chatId: string; senderHandle: string; now: Date },
  env: Record<string, string | undefined> = process.env,
): Promise<GroupLoopGuardVerdict> {
  if (!groupLoopGuardEnabled()) return { verdict: 'off' };
  const guards = schema.linqGroupLoopGuards;

  if ((await groupSpeakerOf(database, input.senderHandle)) === 'person') {
    const closed = await database
      .delete(guards)
      .where(eq(guards.chatId, input.chatId))
      .returning({ quietSince: guards.quietSince });
    return { verdict: 'person', resumed: closed.some((row) => row.quietSince !== null) };
  }

  const cap = groupLoopGuardCap(env);
  await database
    .insert(guards)
    .values({ chatId: input.chatId, runStartedAt: input.now, updatedAt: input.now })
    .onConflictDoNothing({ target: guards.chatId });
  const [run] = await database
    .select({ runStartedAt: guards.runStartedAt, quietSince: guards.quietSince })
    .from(guards)
    .where(eq(guards.chatId, input.chatId));
  // A person spoke between the insert and this read and closed the run: nothing to count.
  if (!run) return { verdict: 'open', haleSince: 0, cap };
  if (run.quietSince) return { verdict: 'quiet', tripped: false, haleSince: null, cap };

  const windowStart = new Date(input.now.getTime() - GROUP_LOOP_GUARD_WINDOW_MS);
  const since = run.runStartedAt > windowStart ? run.runStartedAt : windowStart;
  const haleSince = await countHaleGroupSends(database, input.chatId, since);
  if (haleSince < cap) return { verdict: 'open', haleSince, cap };

  // Only one message takes the chat quiet, however many arrive at once: that one audits
  // and pages, and the rest are ordinary quiet messages.
  const took = await database
    .update(guards)
    .set({ quietSince: input.now, updatedAt: input.now })
    .where(and(eq(guards.chatId, input.chatId), isNull(guards.quietSince)))
    .returning({ chatId: guards.chatId });
  return { verdict: 'quiet', tripped: took.length > 0, haleSince, cap };
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

/** Every household this chat belongs to: the claimed group, its roster, a shared chat's. */
async function familiesInChat(database: Database, chatId: string): Promise<string[]> {
  const claimed = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, chatId));
  const rostered = await database
    .select({ familyId: schema.linqGroupRosters.familyId })
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.chatId, chatId));
  const shared = await presentHouseholds(database, chatId, {
    includeStopped: true,
    includeLeft: false,
  });
  return [
    ...new Set([
      ...claimed.map((row) => row.id),
      ...rostered.flatMap((row) => (row.familyId ? [row.familyId] : [])),
      ...shared,
    ]),
  ];
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
    const families = await familiesInChat(database, input.chatId);
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
  const page = ports.page ?? ((opsPage: OpsPage) => pageOps(database, opsPage));
  let paged: GroupLoopGuardTrip['page'];
  try {
    paged = await page({ site: 'group_loop_guard_tripped', facts: {}, count: input.haleSince });
  } catch (err) {
    paged = 'page_threw';
    console.error(
      { outcome: 'group_loop_guard_page_threw', err: err instanceof Error ? err.name : 'unknown' },
      'group loop guard: the chat is quiet but #ops was not paged',
    );
  }
  return { audited, auditFailed, page: paged };
}
