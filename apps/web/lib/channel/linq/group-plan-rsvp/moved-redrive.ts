import { schema } from '@hale/db';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import { linqGroupPlanRsvpCalendarEnabled, linqGroupPlanRsvpEnabled } from '../config';
import { primaryParentId } from '../roster-ask';
import { movedNoticeDedupeKey, sendMovedNotice } from './calendar-turn';
import {
  type GroupPlanRsvpInboundPorts,
  groupPlanCalendarPorts,
  householdLanguage,
} from './inbound';
import { GROUP_PLAN_CALENDAR_MOVED_VERB, createPostgresGroupPlanRsvpStore } from './store';

/**
 * VIL-689 · the moved-copy notice quiet hours held, sent the next morning.
 *
 * It reads the MOVE, not a refusal: the open set is every move audit row in the staleness
 * window whose notice key nobody has claimed, newest move per (plan, household) only. It
 * rides the shared re-drive slot (redrive-slot.ts): same hour, bound and per-run cap. A
 * plan that closed, or a copy no longer written, owes nothing.
 */

export interface MovedNoticeRedriveResult {
  open: number;
  due: number;
  sent: number;
  skipped: number;
  /** Off with the calendar step: nothing read. */
  dark: boolean;
}

export async function runGroupPlanMovedNoticeRedrive(
  ports: GroupPlanRsvpInboundPorts,
): Promise<MovedNoticeRedriveResult> {
  const result: MovedNoticeRedriveResult = { open: 0, due: 0, sent: 0, skipped: 0, dark: false };
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
    const parent = await primaryParentId(database, move.familyId);
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
    const row = await store.loadCalendarConsent(move.planId, move.familyId);
    if (!plan || plan.closedAt || row?.status !== 'written') {
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
