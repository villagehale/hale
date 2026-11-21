import { schema } from '@hale/db';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import { linqGroupPlanRsvpCalendarEnabled, linqGroupPlanRsvpEnabled } from '../config';
import { copyIsLive } from '../group-plan-invites';
import { householdInChat, postgresGroupPlanHouseholds } from './calendar';
import { movedNoticeDedupeKey, sendMovedNotice } from './calendar-turn';
import {
  type GroupPlanRsvpInboundPorts,
  groupPlanCalendarPorts,
  householdLanguage,
  settleGroupPlanCalendarAfterRsvp,
} from './inbound';
import {
  GROUP_PLAN_CALENDAR_ASK_HELD_VERB,
  GROUP_PLAN_CALENDAR_MOVED_VERB,
  createPostgresGroupPlanRsvpStore,
} from './store';

/**
 * VIL-689 · the moved-copy notice quiet hours held, sent the next morning.
 *
 * It reads the MOVE, not a refusal: the open set is every move audit row in the staleness
 * window whose notice key nobody has claimed, newest move per (plan, household) only. It
 * rides the shared re-drive slot (redrive-slot.ts): same hour, bound and per-run cap. A
 * plan that closed, a copy no longer written or since taken off the calendar, or a household
 * that has left the chat, owes nothing.
 *
 * The OK ask a lock held at night comes back here too: its audit row is the debt, and the ask
 * goes out through the same settle path, with its quiet-hours and prior-1:1 gates, unless the
 * household has since answered, stopped being a yes, or left.
 */

export interface MovedNoticeRedriveResult {
  open: number;
  due: number;
  sent: number;
  skipped: number;
  /** Held OK asks past their night and still owed. */
  asksOpen: number;
  asksSent: number;
  /** Off with the calendar step: nothing read. */
  dark: boolean;
}

export async function runGroupPlanMovedNoticeRedrive(
  ports: GroupPlanRsvpInboundPorts,
): Promise<MovedNoticeRedriveResult> {
  const result: MovedNoticeRedriveResult = {
    open: 0,
    due: 0,
    sent: 0,
    skipped: 0,
    asksOpen: 0,
    asksSent: 0,
    dark: false,
  };
  if (!linqGroupPlanRsvpEnabled() || !linqGroupPlanRsvpCalendarEnabled()) {
    return { ...result, dark: true };
  }
  const { database, now } = ports;
  const moves = await database
    .select({
      id: schema.auditLog.id,
      familyId: schema.auditLog.familyId,
      planId: schema.auditLog.targetId,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, GROUP_PLAN_CALENDAR_MOVED_VERB),
        eq(schema.auditLog.targetTable, 'linq_group_plans'),
        gte(schema.auditLog.occurredAt, new Date(now.getTime() - REDRIVE_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));
  // Only the latest move of a copy is owed: an earlier time is not news any more.
  const latest = new Map<string, { id: string; familyId: string; planId: string }>();
  for (const move of moves) {
    if (!move.planId) continue;
    latest.set(`${move.planId}:${move.familyId}`, { ...move, planId: move.planId });
  }
  const owed = [...latest.values()];
  await redriveHeldAsks(ports, result);
  if (owed.length === 0) return result;
  const claimed = new Set(
    (
      await database
        .select({ dedupeKey: schema.channelMessages.dedupeKey })
        .from(schema.channelMessages)
        .where(
          inArray(
            schema.channelMessages.dedupeKey,
            owed.map((move) => movedNoticeDedupeKey(move.id)),
          ),
        )
    ).map((row) => row.dedupeKey),
  );
  const open = owed.filter((move) => !claimed.has(movedNoticeDedupeKey(move.id)));
  result.open = open.length;

  const store = createPostgresGroupPlanRsvpStore(database);
  const calendar = { store, ...groupPlanCalendarPorts(ports) };
  for (const move of open) {
    if (result.due >= MAX_REDRIVE_PER_RUN) break;
    const row = await store.loadCalendarConsent(move.planId, move.familyId);
    const parent = await store.currentParentOf(move.familyId, row?.decidedByUserId ?? null);
    if (!parent) {
      result.skipped += 1;
      continue;
    }
    if (!isRedriveSlot(now, await redriveParentTimeZone(database, parent))) continue;
    result.due += 1;
    const [plan] = await database
      .select()
      .from(schema.linqGroupPlans)
      .where(eq(schema.linqGroupPlans.id, move.planId));
    if (
      !plan ||
      plan.closedAt ||
      row?.status !== 'written' ||
      !row.familyEventId ||
      !(await copyIsLive(database, row.familyEventId)) ||
      !(await householdInChat(database, plan.chatId, move.familyId))
    ) {
      result.skipped += 1;
      continue;
    }
    const notice = await sendMovedNotice(calendar, {
      plan: {
        id: plan.id,
        chatId: plan.chatId,
        familyId: plan.familyId,
        title: plan.title,
        startsAt: plan.startsAt,
        location: plan.location,
        rsvpDeadlineAt: plan.rsvpDeadlineAt,
        expectedCount: plan.expectedCount,
      },
      row,
      moveId: move.id,
      language: await householdLanguage(database, move.familyId),
    });
    if (notice === 'sent') result.sent += 1;
    else result.skipped += 1;
  }
  return result;
}

/** The OK asks a night lock held, sent in each household's morning slot. */
async function redriveHeldAsks(
  ports: GroupPlanRsvpInboundPorts,
  result: MovedNoticeRedriveResult,
): Promise<void> {
  const { database, now } = ports;
  const held = await database
    .select({ familyId: schema.auditLog.familyId, planId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, GROUP_PLAN_CALENDAR_ASK_HELD_VERB),
        eq(schema.auditLog.targetTable, 'linq_group_plans'),
        gte(schema.auditLog.occurredAt, new Date(now.getTime() - REDRIVE_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));
  const owed = new Map<string, { familyId: string; planId: string }>();
  for (const row of held) {
    if (row.planId) owed.set(`${row.planId}:${row.familyId}`, { ...row, planId: row.planId });
  }
  const store = createPostgresGroupPlanRsvpStore(database);
  const households = postgresGroupPlanHouseholds(database);
  let attempted = 0;
  for (const ask of owed.values()) {
    if (attempted >= MAX_REDRIVE_PER_RUN) break;
    if (await store.loadCalendarConsent(ask.planId, ask.familyId)) continue;
    const [plan] = await database
      .select({
        chatId: schema.linqGroupPlans.chatId,
        startsAt: schema.linqGroupPlans.startsAt,
        closedAt: schema.linqGroupPlans.closedAt,
      })
      .from(schema.linqGroupPlans)
      .where(eq(schema.linqGroupPlans.id, ask.planId));
    if (!plan || plan.closedAt || !plan.startsAt) continue;
    if (!(await householdInChat(database, plan.chatId, ask.familyId))) continue;
    let yes: { memberKey: string; userId: string } | null = null;
    for (const rsvp of await store.listYesRsvps(ask.planId)) {
      if (!rsvp.userId) continue;
      const home = await households.resolve({ chatId: plan.chatId, userId: rsvp.userId });
      if (home.status === 'one' && home.familyId === ask.familyId) {
        yes = { memberKey: rsvp.memberKey, userId: rsvp.userId };
        break;
      }
    }
    if (!yes) continue;
    result.asksOpen += 1;
    const zone = await store.householdTimeZone(ask.familyId);
    if (!zone || !isRedriveSlot(now, zone)) continue;
    attempted += 1;
    const { rows } = await store.loadTally(ask.planId);
    const effect = await settleGroupPlanCalendarAfterRsvp(ports, {
      chatId: plan.chatId,
      planId: ask.planId,
      userId: yes.userId,
      memberKey: yes.memberKey,
      displayName: rows.find((row) => row.memberKey === yes?.memberKey)?.displayName ?? 'someone',
      response: 'yes',
      parentWords: null,
      proactive: true,
    });
    if (effect?.status === 'asked') result.asksSent += 1;
  }
}
