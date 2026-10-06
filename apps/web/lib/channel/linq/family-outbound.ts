import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { dutySyncLine, dutyTitleMayBeSpoken } from '~/lib/channel/coparent/duty/sync-line';
import { CO_PARENT_ASK_BY_LANGUAGE } from '~/lib/channel/intake/copy';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import {
  configuredOutboundChannel,
  readSendRefusal,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import type { ContentClass } from '~/lib/channel/role-scope';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { linqApiKey, linqGroupCoparentEnabled } from './config';
import { LINQ_GROUP_TRIGGER_PHRASE } from './group';
import { type GroupHoldReason, groupAudienceAllows } from './group-audience';
import { groupPassedSyncLine, groupPickedSyncLine } from './group-coparent-copy';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Where a Hale-initiated message for this family goes.
 *
 * A claimed Linq group (`families.linq_group_chat_id`) is the home channel:
 * proactive sends use it and do not also go out 1:1 or by SMS. No group, or the
 * kill switch `LINQ_GROUP_COPARENT=off`, leaves the caller's current door.
 * A parent who texts Hale 1:1 is answered in that thread; this resolver is not
 * the reply door.
 *
 * With `LINQ_GROUP_ONBOARDING_V2_ENABLED`, a claimed chat is the target only for
 * a `contentClass` everyone in it may see (group-audience.ts); otherwise the
 * caller's 1:1 door, with the hold named in `reason`.
 */
export type FamilyOutboundTarget =
  | { channel: 'group'; chatId: string; familyId: string }
  | { channel: 'legacy'; reason?: GroupHoldReason };

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SETTLE_MS = 10 * 60 * 1000;
const SYNC_LINE_MAX = 3;
export const GROUP_DISCRETIONARY_DAY_MAX = 1;
export const GROUP_DISCRETIONARY_WEEK_MAX = 3;
export const GROUP_HARD_DAY_MAX = 2;
const QUIET_START = '21:00:00';
const QUIET_END = '08:00:00';

/** Kid-event, conflict, handoff, post-event, both-free, who-takes. The 1/day and 3/week budget. */
const DISCRETIONARY_TEMPLATES = [
  'linq:group_kid_event',
  'linq:group_conflict',
  'linq:group_handoff',
  'linq:group_followup',
  'linq:group_both_free',
  'linq:group_who_takes',
  // VIL-382 · night-before duty confirmation. The Sunday overview is folded into
  // the weekly nudge and does not take a template of its own.
  'linq:group_duty_night_before',
] as const;

const SYNC_TEMPLATE = 'linq:group_sync';

/** A picked, passed or duty decision about a kid's activity: the household's schedule. */
const DECISION_SYNC_CLASS: ContentClass = 'schedule';

/**
 * How a group send spends the household budget.
 *
 * `uncapped` is a reply, a receipt, or an onboarding turn the parent is already
 * in. `ceiling` is any other proactive bubble: at most two a day, quiet hours
 * included. `discretionary` is the narrower 1/day and 3/week list, and it also
 * counts toward that ceiling. `rec_morning` is the registration-morning nudge:
 * exempt from the narrow list, still under the ceiling, and the one kind that
 * still leaves when the ceiling is already met (it outranks the others).
 * `weekly_followup` and `sync` are exempt from the narrow list and stop at the
 * ceiling.
 */
export type GroupBubbleKind =
  | 'uncapped'
  | 'ceiling'
  | 'discretionary'
  | 'rec_morning'
  | 'weekly_followup'
  | 'sync';

export async function familyOutboundTarget(
  database: Database,
  familyId: string,
  options: { contentClass?: ContentClass } = {},
): Promise<FamilyOutboundTarget> {
  if (!linqGroupCoparentEnabled()) return { channel: 'legacy' };
  // A unit double with no query surface has no group to claim. Production
  // databases always expose `select`.
  if (typeof database.select !== 'function') return { channel: 'legacy' };
  const rows = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const chatId = rows[0]?.linqGroupChatId;
  if (!chatId) return { channel: 'legacy' };
  const audience = await groupAudienceAllows(
    database,
    chatId,
    options.contentClass ?? 'unclassified',
  );
  if (!audience.allowed) return { channel: 'legacy', reason: audience.reason };
  return { channel: 'group', chatId, familyId };
}

/** The family of a parent, when they have one. The Sunday loop is addressed by
 * user id; this is how that send finds the group. */
export async function familyOutboundTargetForUser(
  database: Database,
  userId: string,
): Promise<FamilyOutboundTarget> {
  if (!linqGroupCoparentEnabled()) return { channel: 'legacy' };
  if (typeof database.select !== 'function') return { channel: 'legacy' };
  const memberships = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId));
  const seat = memberships.find(
    (row) => row.userId === userId && (row.role === 'primary_parent' || row.role === 'co_parent'),
  );
  if (!seat) return { channel: 'legacy' };
  return familyOutboundTarget(database, seat.familyId);
}

export interface GroupSpend {
  discretionaryDay: number;
  discretionaryWeek: number;
  ceilingToday: number;
  /** Instants inside each window, oldest-first is not required. */
  discretionaryDayAt: Date[];
  discretionaryWeekAt: Date[];
  ceilingTodayAt: Date[];
}

export async function readGroupBubbleSpend(
  database: Database,
  input: { familyId: string; chatId: string; now: Date },
): Promise<GroupSpend> {
  if (typeof database.select !== 'function') {
    return {
      discretionaryDay: 0,
      discretionaryWeek: 0,
      ceilingToday: 0,
      discretionaryDayAt: [],
      discretionaryWeekAt: [],
      ceilingTodayAt: [],
    };
  }
  const since = new Date(input.now.getTime() - WEEK_MS);
  const rows = await database
    .select({
      createdAt: schema.channelMessages.createdAt,
      status: schema.channelMessages.status,
      templateKey: schema.channelMessages.templateKey,
      category: schema.channelMessages.category,
      providerChatId: schema.channelMessages.providerChatId,
      familyId: schema.channelMessages.familyId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.providerChatId, input.chatId),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const sent = rows.filter(
    (row) =>
      row.familyId === input.familyId &&
      row.providerChatId === input.chatId &&
      (SENT_STATUSES as readonly string[]).includes(row.status),
  );
  const dayAgo = input.now.getTime() - DAY_MS;
  const discretionary = sent.filter(
    (row) =>
      (DISCRETIONARY_TEMPLATES as readonly string[]).includes(row.templateKey ?? '') ||
      row.category === 'followup' ||
      row.category === 'activity_followup' ||
      row.category === 'calendar_alert',
  );
  const ceiling = sent.filter(
    (row) => row.category !== 'reply' || row.templateKey === SYNC_TEMPLATE,
  );
  const discretionaryDayRows = discretionary.filter((row) => row.createdAt.getTime() >= dayAgo);
  const ceilingTodayRows = ceiling.filter((row) => row.createdAt.getTime() >= dayAgo);
  return {
    discretionaryDay: discretionaryDayRows.length,
    discretionaryWeek: discretionary.length,
    ceilingToday: ceilingTodayRows.length,
    discretionaryDayAt: discretionaryDayRows.map((row) => row.createdAt),
    discretionaryWeekAt: discretionary.map((row) => row.createdAt),
    ceilingTodayAt: ceilingTodayRows.map((row) => row.createdAt),
  };
}

/**
 * One discretionary bubble a day and three a week, and never a third proactive
 * bubble in a day. Household calendar notices use this before they speak.
 */
export async function groupProactiveCapReached(
  database: Database,
  input: { familyId: string; chatId: string; now: Date },
): Promise<boolean> {
  const spend = await readGroupBubbleSpend(database, input);
  return (
    spend.discretionaryDay >= GROUP_DISCRETIONARY_DAY_MAX ||
    spend.discretionaryWeek >= GROUP_DISCRETIONARY_WEEK_MAX ||
    spend.ceilingToday >= GROUP_HARD_DAY_MAX
  );
}

async function householdQuiet(database: Database, familyId: string, now: Date): Promise<boolean> {
  if (typeof database.select !== 'function') return false;
  const members = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const seat = members.find(
    (row) =>
      row.familyId === familyId && (row.role === 'primary_parent' || row.role === 'co_parent'),
  );
  let timeZone = 'America/Toronto';
  if (seat) {
    const [user] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, seat.userId))
      .limit(1);
    if (user?.timezone) timeZone = user.timezone;
  }
  return isWithinQuietHours(now, timeZone, QUIET_START, QUIET_END);
}

/**
 * When a rolling cap releases. The pivot is the message that has to age out
 * before the count drops below the max (`inWindow[count - max]`). Several
 * caps can bind at once; the send stays held until the latest of them.
 * `+ 1ms` is the first instant `createdAt >= now - window` no longer holds.
 */
function windowResetsAt(timestamps: readonly Date[], max: number, windowMs: number): Date | null {
  if (max <= 0 || timestamps.length < max) return null;
  const ordered = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const pivot = ordered[ordered.length - max];
  if (!pivot) return null;
  return new Date(pivot.getTime() + windowMs + 1);
}

export function groupCapResetsAt(kind: GroupBubbleKind, spend: GroupSpend, now: Date): Date {
  const resets: Date[] = [];
  const push = (at: Date | null) => {
    if (at) resets.push(at);
  };
  if (kind !== 'uncapped' && kind !== 'rec_morning' && spend.ceilingToday >= GROUP_HARD_DAY_MAX) {
    push(windowResetsAt(spend.ceilingTodayAt, GROUP_HARD_DAY_MAX, DAY_MS));
  }
  if (kind === 'discretionary') {
    if (spend.discretionaryDay >= GROUP_DISCRETIONARY_DAY_MAX) {
      push(windowResetsAt(spend.discretionaryDayAt, GROUP_DISCRETIONARY_DAY_MAX, DAY_MS));
    }
    if (spend.discretionaryWeek >= GROUP_DISCRETIONARY_WEEK_MAX) {
      push(windowResetsAt(spend.discretionaryWeekAt, GROUP_DISCRETIONARY_WEEK_MAX, WEEK_MS));
    }
  }
  if (resets.length === 0) return new Date(now.getTime() + DAY_MS + 1);
  return resets.reduce((latest, at) => (at.getTime() > latest.getTime() ? at : latest));
}

function kindHeld(kind: GroupBubbleKind, spend: GroupSpend): 'group_cap' | null {
  if (kind === 'uncapped') return null;
  const ceiling = spend.ceilingToday >= GROUP_HARD_DAY_MAX;
  if (kind === 'rec_morning') return null;
  if (ceiling) return 'group_cap';
  if (kind !== 'discretionary') return null;
  if (
    spend.discretionaryDay >= GROUP_DISCRETIONARY_DAY_MAX ||
    spend.discretionaryWeek >= GROUP_DISCRETIONARY_WEEK_MAX
  ) {
    return 'group_cap';
  }
  return null;
}

export type FamilyOutboundDelivery =
  | {
      status: 'sent';
      providerMessageId: string;
      channel: 'sms' | 'imessage';
      chatId: string | null;
      linkOmitted?: 'link_on_new_chat';
    }
  | { status: 'held'; reason: 'group_cap'; until: Date }
  | { status: 'held'; reason: 'quiet_hours' | 'coparent_ask' }
  | { status: 'skipped'; reason: string };

function skippedRefusal(familyId: string, err: unknown): FamilyOutboundDelivery | null {
  const refusal = readSendRefusal(err);
  if (!refusal) return null;
  if (refusal.code !== 'not_configured' && !refusal.permanent) return null;
  console.warn({ familyId, code: refusal.code }, 'family outbound: provider refused — not sent');
  return { status: 'skipped', reason: refusal.code };
}

function isCoparentAsk(body: string): boolean {
  return (
    body.includes(CO_PARENT_ASK_BY_LANGUAGE.en) ||
    body.includes(CO_PARENT_ASK_BY_LANGUAGE.fr) ||
    body.includes("Want the other parent on the kids' year") ||
    body.includes("l'autre parent sur l'ann") ||
    body.includes(`send: ${LINQ_GROUP_TRIGGER_PHRASE.en}`) ||
    body.includes(`envoie: ${LINQ_GROUP_TRIGGER_PHRASE.fr}`)
  );
}

/**
 * Send one Hale-initiated body. A group target uses Linq on
 * `linq_group_chat_id` and does not call the legacy transport. No group uses
 * the legacy transport unchanged.
 *
 * `shareGroupCap` false is the uncapped door (a reply the parent is already
 * in, or a spot they asked to hear about). Pass `bubbleKind` when the send
 * has a named budget. The co-parent ask never leaves into a claimed group.
 */
export async function deliverFamilyOutbound(
  database: Database,
  input: {
    familyId: string;
    body: string;
    to: string;
    legacy: ChannelTransport;
    target?: FamilyOutboundTarget;
    fetch?: typeof fetch;
    shareGroupCap?: boolean;
    bubbleKind?: GroupBubbleKind;
    mediaUrls?: string[];
    now?: Date;
  },
): Promise<FamilyOutboundDelivery> {
  const target = input.target ?? (await familyOutboundTarget(database, input.familyId));
  if (target.channel === 'group') {
    if (isCoparentAsk(input.body)) {
      console.warn(
        { familyId: input.familyId },
        'family outbound: co-parent ask stays 1:1 — not sent in the group',
      );
      return { status: 'held', reason: 'coparent_ask' };
    }
    const kind: GroupBubbleKind =
      input.bubbleKind ?? (input.shareGroupCap === false ? 'uncapped' : 'ceiling');
    const now = input.now ?? new Date();
    // Rec-morning keeps the registration ladder's existing timing, which is
    // allowed to cross quiet hours: the doors open before 08:00.
    if (
      kind !== 'uncapped' &&
      kind !== 'rec_morning' &&
      (await householdQuiet(database, input.familyId, now))
    ) {
      console.warn(
        { familyId: input.familyId },
        'family outbound: quiet hours — not sent, and not retried on SMS',
      );
      return { status: 'held', reason: 'quiet_hours' };
    }
    const spend = await readGroupBubbleSpend(database, {
      familyId: input.familyId,
      chatId: target.chatId,
      now,
    });
    const held = kindHeld(kind, spend);
    if (held) {
      console.warn(
        { familyId: input.familyId, kind },
        'family outbound: group cap reached — not sent, and not retried on SMS',
      );
      return { status: 'held', reason: held, until: groupCapResetsAt(kind, spend, now) };
    }
    if (kind === 'rec_morning' && spend.ceilingToday >= GROUP_HARD_DAY_MAX) {
      console.warn(
        { familyId: input.familyId },
        'family outbound: ceiling already met — rec-morning still sent',
      );
    }
    try {
      const sent = await sendLinqChatMessage({
        chatId: target.chatId,
        text: input.body,
        fetch: input.fetch,
      });
      return {
        status: 'sent',
        providerMessageId: sent.providerMessageId,
        channel: 'imessage',
        chatId: target.chatId,
      };
    } catch (err) {
      const skipped = skippedRefusal(input.familyId, err);
      if (skipped) return skipped;
      throw err;
    }
  }
  try {
    const sent = await sendResolvingNewChat(input.legacy, {
      to: input.to,
      body: input.body,
      mediaUrls: input.mediaUrls,
    });
    const channel = sent.transport === 'imessage' ? 'imessage' : 'sms';
    return {
      status: 'sent',
      providerMessageId: sent.providerMessageId,
      channel,
      chatId: sent.chatId ?? null,
      ...(sent.linkOmitted ? { linkOmitted: sent.linkOmitted } : {}),
    };
  } catch (err) {
    const skipped = skippedRefusal(input.familyId, err);
    if (skipped) return skipped;
    throw err;
  }
}

/**
 * A permanent provider refusal, on the ledger, so the next tick does not send
 * it again. `not_configured` writes nothing: the door may exist on a later tick.
 * A database double with no insert is a unit test; production always inserts.
 */
export async function notePermanentSkip(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    category: (typeof schema.channelMessages.$inferInsert)['category'];
    templateKey: string;
    dedupeKey: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  if (input.reason === 'not_configured') return;
  if (typeof database.insert !== 'function') return;
  await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: configuredOutboundChannel(),
      direction: 'out',
      category: input.category,
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      status: 'failed',
      errorCode: input.reason,
      sentAt: input.now,
    })
    .onConflictDoNothing();
}

/** One wire copy when the household shares a group. Every recipient otherwise. */
export function householdCopies<T>(
  target: FamilyOutboundTarget,
  recipients: readonly T[],
): readonly T[] {
  if (target.channel === 'group') return recipients.slice(0, 1);
  return recipients;
}

export interface GroupActivityDecision {
  decision: 'picked' | 'passed' | 'duty';
  activity: string;
  kid: string;
  day?: string;
  time?: string;
}

export async function familySpeech(
  database: Database,
  familyId: string,
  userId: string,
): Promise<{ name: string | null; language: ReplyLanguage }> {
  if (typeof database.select !== 'function') return { name: null, language: 'en' };
  const [family] = await database
    .select({ primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const [user] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const language: ReplyLanguage = family?.primaryLanguage?.toLowerCase().startsWith('fr')
    ? 'fr'
    : 'en';
  const name = user?.name?.trim() || null;
  return { name, language };
}

/**
 * Queue one picked or passed activity from a 1:1 thread. The group hears it
 * only after the thread has been quiet. A question, a piece of advice, or a
 * decision this template does not cover is not queued.
 */
export async function queueGroupActivityDecision(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    originChatId: string | null;
    decision: GroupActivityDecision;
    now: Date;
  },
): Promise<'queued' | 'skipped'> {
  const target = await familyOutboundTarget(database, input.familyId, {
    contentClass: DECISION_SYNC_CLASS,
  });
  if (target.channel !== 'group') return 'skipped';
  if (input.originChatId !== null && input.originChatId === target.chatId) return 'skipped';
  const { decision } = input;
  if (!decision.activity.trim() || !decision.kid.trim()) return 'skipped';
  const timed = decision.decision === 'picked' || decision.decision === 'duty';
  if (timed && (!decision.day?.trim() || !decision.time?.trim())) return 'skipped';
  if (decision.decision === 'passed' && (decision.day || decision.time)) return 'skipped';
  if (decision.decision === 'duty' && !dutyTitleMayBeSpoken(decision.activity)) return 'skipped';
  const activity = decision.activity.trim();
  const kid = decision.kid.trim();
  const day = timed ? (decision.day?.trim() ?? null) : null;
  const time = timed ? (decision.time?.trim() ?? null) : null;
  const flushAfter = new Date(input.now.getTime() + SETTLE_MS);
  const prior = await database
    .select({
      familyId: schema.groupDecisionSync.familyId,
      decision: schema.groupDecisionSync.decision,
      activity: schema.groupDecisionSync.activity,
      kid: schema.groupDecisionSync.kid,
      day: schema.groupDecisionSync.day,
      time: schema.groupDecisionSync.time,
      flushedAt: schema.groupDecisionSync.flushedAt,
    })
    .from(schema.groupDecisionSync)
    .where(eq(schema.groupDecisionSync.familyId, input.familyId));
  const sameSlot = (row: (typeof prior)[number]) =>
    row.familyId === input.familyId &&
    row.decision === decision.decision &&
    row.activity === activity &&
    row.kid === kid &&
    (row.day ?? null) === day &&
    (row.time ?? null) === time;
  if (prior.some((row) => row.flushedAt === null && sameSlot(row))) {
    await database
      .update(schema.groupDecisionSync)
      .set({ flushAfter })
      .where(
        and(
          eq(schema.groupDecisionSync.familyId, input.familyId),
          isNull(schema.groupDecisionSync.flushedAt),
        ),
      );
    return 'queued';
  }
  const recent = input.now.getTime() - DAY_MS;
  if (
    prior.some(
      (row) => row.flushedAt !== null && row.flushedAt.getTime() >= recent && sameSlot(row),
    )
  ) {
    return 'skipped';
  }
  await database
    .update(schema.groupDecisionSync)
    .set({ flushAfter })
    .where(
      and(
        eq(schema.groupDecisionSync.familyId, input.familyId),
        isNull(schema.groupDecisionSync.flushedAt),
      ),
    );
  await database.insert(schema.groupDecisionSync).values({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    originChatId: input.originChatId,
    decision: decision.decision,
    activity,
    kid,
    day,
    time,
    flushAfter,
    createdAt: input.now,
  });
  return 'queued';
}

/** Another 1:1 line arrived. A waiting sync stays unsent until this thread is quiet. */
export async function noteGroupSyncConversation(
  database: Database,
  input: { familyId: string; originChatId: string | null; now: Date },
): Promise<void> {
  if (typeof database.update !== 'function') return;
  const target = await familyOutboundTarget(database, input.familyId, {
    contentClass: DECISION_SYNC_CLASS,
  });
  if (target.channel !== 'group') return;
  if (input.originChatId !== null && input.originChatId === target.chatId) return;
  await database
    .update(schema.groupDecisionSync)
    .set({ flushAfter: new Date(input.now.getTime() + SETTLE_MS) })
    .where(
      and(
        eq(schema.groupDecisionSync.familyId, input.familyId),
        isNull(schema.groupDecisionSync.flushedAt),
      ),
    );
}

/**
 * Send the waiting decisions whose 1:1 has been quiet. One bubble, at most
 * three lines, never a second bubble for the same sitting. Quiet hours hold
 * the bubble; the rows stay queued.
 */
export async function flushGroupDecisionSyncs(
  database: Database,
  input: { now: Date; fetch?: typeof fetch },
): Promise<{ sent: number; held: number }> {
  if (typeof database.select !== 'function') return { sent: 0, held: 0 };
  const waiting = await database
    .select({
      id: schema.groupDecisionSync.id,
      familyId: schema.groupDecisionSync.familyId,
      parentUserId: schema.groupDecisionSync.parentUserId,
      decision: schema.groupDecisionSync.decision,
      activity: schema.groupDecisionSync.activity,
      kid: schema.groupDecisionSync.kid,
      day: schema.groupDecisionSync.day,
      time: schema.groupDecisionSync.time,
      flushAfter: schema.groupDecisionSync.flushAfter,
      createdAt: schema.groupDecisionSync.createdAt,
      flushedAt: schema.groupDecisionSync.flushedAt,
    })
    .from(schema.groupDecisionSync)
    .where(isNull(schema.groupDecisionSync.flushedAt));
  const due = waiting.filter(
    (row) => row.flushedAt === null && row.flushAfter.getTime() <= input.now.getTime(),
  );
  const byFamily = new Map<string, typeof due>();
  for (const row of due) {
    const list = byFamily.get(row.familyId) ?? [];
    list.push(row);
    byFamily.set(row.familyId, list);
  }
  let sent = 0;
  let held = 0;
  for (const [familyId, rows] of byFamily) {
    const target = await familyOutboundTarget(database, familyId, {
      contentClass: DECISION_SYNC_CLASS,
    });
    if (target.channel !== 'group') {
      await database
        .update(schema.groupDecisionSync)
        .set({ flushedAt: input.now })
        .where(
          and(
            eq(schema.groupDecisionSync.familyId, familyId),
            isNull(schema.groupDecisionSync.flushedAt),
          ),
        );
      continue;
    }
    if (await householdQuiet(database, familyId, input.now)) {
      held += 1;
      continue;
    }
    const spend = await readGroupBubbleSpend(database, {
      familyId,
      chatId: target.chatId,
      now: input.now,
    });
    if (spend.ceilingToday >= GROUP_HARD_DAY_MAX) {
      held += 1;
      continue;
    }
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const speech = await familySpeech(database, familyId, rows[0]?.parentUserId ?? '');
    const lines: string[] = [];
    for (const row of rows) {
      if (lines.length >= SYNC_LINE_MAX) break;
      const name = speech.name ?? (speech.language === 'fr' ? 'Un parent' : 'A parent');
      if (row.decision === 'picked' && row.day && row.time) {
        lines.push(
          groupPickedSyncLine(speech.language, {
            name,
            activity: row.activity,
            kid: row.kid,
            day: row.day,
            time: row.time,
          }),
        );
      } else if (row.decision === 'passed') {
        lines.push(
          groupPassedSyncLine(speech.language, {
            name,
            activity: row.activity,
            kid: row.kid,
          }),
        );
      } else if (row.decision === 'duty' && row.day && row.time) {
        const line = dutySyncLine(speech.language, {
          name: speech.name,
          activity: row.activity,
          kid: row.kid,
          day: row.day,
          time: row.time,
        });
        if (line && line.split('\n').length <= 1) lines.push(line);
      }
    }
    if (lines.length === 0) continue;
    const actor = rows[0]?.parentUserId;
    if (!actor) continue;
    const [claimed] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId: actor,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: SYNC_TEMPLATE,
        dedupeKey: `linq:group_sync:${familyId}:${input.now.toISOString()}`,
        providerChatId: target.chatId,
        status: acceptedStatus('imessage'),
        sentAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.channelMessages.id });
    if (!claimed) continue;
    try {
      const delivered = await sendLinqChatMessage({
        chatId: target.chatId,
        text: lines.join('\n'),
        fetch: input.fetch,
      });
      await database
        .update(schema.channelMessages)
        .set({ providerMessageId: delivered.providerMessageId })
        .where(eq(schema.channelMessages.id, claimed.id));
      await database.insert(schema.auditLog).values({
        familyId,
        actor,
        actionTaken: 'group_decision_sync_sent',
        targetTable: 'channel_messages',
        targetId: claimed.id,
        after: { lines: lines.length },
      });
      const dueIds = rows.map((row) => row.id);
      await database
        .update(schema.groupDecisionSync)
        .set({ flushedAt: input.now })
        .where(inArray(schema.groupDecisionSync.id, dueIds));
      sent += 1;
    } catch (err) {
      const code = err instanceof Error ? err.name : 'unknown';
      await database
        .update(schema.channelMessages)
        .set({ status: 'failed', errorCode: code })
        .where(eq(schema.channelMessages.id, claimed.id));
      console.warn({ familyId, code }, 'family outbound: group sync did not land');
    }
  }
  return { sent, held };
}

/**
 * A decision the parent already made, mirrored into the claimed group.
 * The chat id has to be that family's group. Anything else — including a
 * 1:1 — is refused and nothing is sent. The ledger row is written first.
 */
export async function sendClaimedGroupLine(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    body: string;
    now: Date;
    dedupeKey: string;
    templateKey: string;
    contentClass: ContentClass;
  },
): Promise<
  | 'sent'
  | 'not_configured'
  | 'not_the_group'
  | 'already_sent'
  | 'not_sent'
  | 'group_audience_refused'
> {
  if (!linqApiKey()) return 'not_configured';
  const [family] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family?.linqGroupChatId || family.linqGroupChatId !== input.chatId) {
    return 'not_the_group';
  }
  if (!(await groupAudienceAllows(database, input.chatId, input.contentClass)).allowed) {
    return 'group_audience_refused';
  }
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';
  try {
    const delivered = await sendLinqChatMessage({ chatId: input.chatId, text: input.body });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: delivered.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: input.templateKey },
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    return 'not_sent';
  }
}
