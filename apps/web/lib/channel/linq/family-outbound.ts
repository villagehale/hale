import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { CO_PARENT_ASK_BY_LANGUAGE } from '~/lib/channel/intake/copy';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { linqGroupCoparentEnabled } from './config';
import { LINQ_GROUP_TRIGGER_PHRASE } from './group';
import { groupPassedSyncLine, groupPickedSyncLine } from './group-coparent-copy';
import { sendLinqChatMessage } from './transport';

/**
 * Where a Hale-initiated message for this family goes.
 *
 * A claimed Linq group (`families.linq_group_chat_id`) is the home channel:
 * proactive sends use it and do not also go out 1:1 or by SMS. No group, or the
 * kill switch `LINQ_GROUP_COPARENT=off`, leaves the caller's current door.
 * A parent who texts Hale 1:1 is answered in that thread; this resolver is not
 * the reply door.
 */
export type FamilyOutboundTarget =
  | { channel: 'group'; chatId: string; familyId: string }
  | { channel: 'legacy' };

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SETTLE_MS = 10 * 60 * 1000;
const SYNC_LINE_MAX = 3;
const DISCRETIONARY_DAY_MAX = 1;
const DISCRETIONARY_WEEK_MAX = 3;
const HARD_DAY_MAX = 2;
const QUIET_START = '21:00:00';
const QUIET_END = '08:00:00';

/** Kid-event, conflict, handoff, post-event, both-free. The 1/day and 3/week budget. */
const DISCRETIONARY_TEMPLATES = [
  'linq:group_kid_event',
  'linq:group_conflict',
  'linq:group_handoff',
  'linq:group_followup',
  'linq:group_both_free',
] as const;

const SYNC_TEMPLATE = 'linq:group_sync';

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

interface GroupSpend {
  discretionaryDay: number;
  discretionaryWeek: number;
  ceilingToday: number;
}

async function groupSpend(
  database: Database,
  input: { familyId: string; chatId: string; now: Date },
): Promise<GroupSpend> {
  if (typeof database.select !== 'function') {
    return { discretionaryDay: 0, discretionaryWeek: 0, ceilingToday: 0 };
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
  return {
    discretionaryDay: discretionary.filter((row) => row.createdAt.getTime() >= dayAgo).length,
    discretionaryWeek: discretionary.length,
    ceilingToday: ceiling.filter((row) => row.createdAt.getTime() >= dayAgo).length,
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
  const spend = await groupSpend(database, input);
  return (
    spend.discretionaryDay >= DISCRETIONARY_DAY_MAX ||
    spend.discretionaryWeek >= DISCRETIONARY_WEEK_MAX ||
    spend.ceilingToday >= HARD_DAY_MAX
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

function kindHeld(kind: GroupBubbleKind, spend: GroupSpend): 'group_cap' | null {
  if (kind === 'uncapped') return null;
  const ceiling = spend.ceilingToday >= HARD_DAY_MAX;
  if (kind === 'rec_morning') return null;
  if (ceiling) return 'group_cap';
  if (kind !== 'discretionary') return null;
  if (
    spend.discretionaryDay >= DISCRETIONARY_DAY_MAX ||
    spend.discretionaryWeek >= DISCRETIONARY_WEEK_MAX
  ) {
    return 'group_cap';
  }
  return null;
}

export type FamilyOutboundDelivery =
  | {
      status: 'sent';
      providerMessageId: string;
      channel: 'sms' | 'imessage' | 'whatsapp';
      chatId: string | null;
    }
  | { status: 'held'; reason: 'group_cap' | 'quiet_hours' | 'coparent_ask' };

function isCoparentAsk(body: string): boolean {
  return (
    body.includes(CO_PARENT_ASK_BY_LANGUAGE.en) ||
    body.includes(CO_PARENT_ASK_BY_LANGUAGE.fr) ||
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
    const spend = await groupSpend(database, {
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
      return { status: 'held', reason: held };
    }
    if (kind === 'rec_morning' && spend.ceilingToday >= HARD_DAY_MAX) {
      console.warn(
        { familyId: input.familyId },
        'family outbound: ceiling already met — rec-morning still sent',
      );
    }
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
  }
  const sent = await input.legacy.send({
    to: input.to,
    body: input.body,
    mediaUrls: input.mediaUrls,
  });
  const channel =
    sent.transport === 'imessage' ? 'imessage' : sent.transport === 'whatsapp' ? 'whatsapp' : 'sms';
  return {
    status: 'sent',
    providerMessageId: sent.providerMessageId,
    channel,
    chatId: sent.chatId ?? null,
  };
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
  decision: 'picked' | 'passed';
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
  const target = await familyOutboundTarget(database, input.familyId);
  if (target.channel !== 'group') return 'skipped';
  if (input.originChatId !== null && input.originChatId === target.chatId) return 'skipped';
  const { decision } = input;
  if (!decision.activity.trim() || !decision.kid.trim()) return 'skipped';
  if (decision.decision === 'picked' && (!decision.day?.trim() || !decision.time?.trim())) {
    return 'skipped';
  }
  if (decision.decision === 'passed' && (decision.day || decision.time)) return 'skipped';
  const activity = decision.activity.trim();
  const kid = decision.kid.trim();
  const day = decision.decision === 'picked' ? (decision.day?.trim() ?? null) : null;
  const time = decision.decision === 'picked' ? (decision.time?.trim() ?? null) : null;
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
  const target = await familyOutboundTarget(database, input.familyId);
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
    const target = await familyOutboundTarget(database, familyId);
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
    const spend = await groupSpend(database, {
      familyId,
      chatId: target.chatId,
      now: input.now,
    });
    if (spend.ceilingToday >= HARD_DAY_MAX) {
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
