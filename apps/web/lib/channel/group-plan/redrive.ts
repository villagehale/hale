import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteMethod,
  CalendarInviteReport,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import { loadInviteEventRow } from '~/lib/loop/ics-invite';
import type { GroupPlan } from './send';

/**
 * VIL-443 · a family group's plan text that quiet hours held, sent the next morning.
 *
 * A plan approved at night waits for the group's morning. Handing it to each parent as a
 * time-sensitive 1:1 invite instead would cross the very quiet hours that held it. The
 * hold is an audit row written where the gate said no; this sweep is the other half, on
 * the same hourly leg, local hour, staleness bound and per-run cap as every other
 * re-drive (redrive-slot.ts).
 *
 * IT SENDS THROUGH THE SAME DOOR: the decorated calendar-invite sender the placement
 * called. So the plan is read again (a move overnight goes out as its latest revision),
 * the group's audience gate is asked again, the model writes the text or nothing goes,
 * and a group that still cannot be told gives its parents their own invites, by day.
 *
 * A hold is open until a release row closes it. Every way a re-drive ends writes one,
 * except a gate that still reads night and a throw: those come back the next morning
 * until the week is out. A plan already under way by its morning is released unsent.
 */

/** A group text still waiting for its morning. */
export interface OpenGroupPlanHold {
  familyId: string;
  /** The calendar_add that placed the plan: what its hold and release rows target. */
  placedByActionId: string;
  familyEventId: string;
  dedupeKey: string;
  method: CalendarInviteMethod;
  /** The parent whose clock the quiet-hours gate read. */
  gateUserId: string;
}

/**
 * Every way a tick ends, counted (rule #11). `open` is what the sweep looked at and `due`
 * the slice whose morning it is; without both, the zero most ticks return is unreadable.
 */
export interface GroupPlanReportRedriveResult {
  open: number;
  due: number;
  /** Past this run's cap: still held, and first in line next tick. */
  deferred: number;
  sent: number;
  alreadySent: number;
  /** The gate still reads night: kept for the next morning. */
  heldAgain: number;
  /** The group could not be told this morning, so each parent got their own invite. */
  toParents: number;
  /** The model could not write the text: nothing sent, ops paged. */
  unwritten: number;
  noLink: number;
  /** Under way by its morning: released unsent. */
  started: number;
  /** An added or moved plan whose row is gone: nothing left to add. */
  gone: number;
  /** Threw, or could not read the plan: kept for the next morning. */
  errored: number;
}

type Ended = Exclude<keyof GroupPlanReportRedriveResult, 'open' | 'due' | 'deferred'>;

export function emptyGroupPlanRedriveResult(): GroupPlanReportRedriveResult {
  return {
    open: 0,
    due: 0,
    deferred: 0,
    sent: 0,
    alreadySent: 0,
    heldAgain: 0,
    toParents: 0,
    unwritten: 0,
    noLink: 0,
    started: 0,
    gone: 0,
    errored: 0,
  };
}

function readMark(after: unknown): {
  familyEventId: string;
  dedupeKey: string;
  method: CalendarInviteMethod | null;
  gateUserId: string | null;
} | null {
  if (typeof after !== 'object' || after === null) return null;
  const { familyEventId, dedupeKey, method, gateUserId } = after as Record<string, unknown>;
  if (typeof familyEventId !== 'string' || typeof dedupeKey !== 'string') return null;
  return {
    familyEventId,
    dedupeKey,
    method: method === 'REQUEST' || method === 'CANCEL' ? method : null,
    gateUserId: typeof gateUserId === 'string' ? gateUserId : null,
  };
}

/**
 * The holds inside the staleness window whose latest mark is a hold, oldest first: the
 * per-run cap's fairness. Two holds for one key (two callers racing the same night) are
 * one hold, and one release closes it.
 *
 * Holds and releases target the placing action, never the event: every audit row on a
 * family_events row is a revision of it (icsSequence), and waiting is not a change.
 */
async function readOpenHolds(
  database: Database,
  now: Date,
  scope?: { familyId: string; placedByActionId: string },
): Promise<OpenGroupPlanHold[]> {
  const rows = await database
    .select({
      familyId: schema.auditLog.familyId,
      placedByActionId: schema.auditLog.targetId,
      actionTaken: schema.auditLog.actionTaken,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        inArray(schema.auditLog.actionTaken, [
          'group_plan.report_held',
          'group_plan.report_released',
        ]),
        eq(schema.auditLog.targetTable, 'actions'),
        gte(schema.auditLog.occurredAt, new Date(now.getTime() - REDRIVE_MAX_AGE_MS)),
        scope ? eq(schema.auditLog.familyId, scope.familyId) : undefined,
        scope ? eq(schema.auditLog.targetId, scope.placedByActionId) : undefined,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const open = new Map<string, OpenGroupPlanHold>();
  for (const row of rows) {
    const mark = readMark(row.after);
    if (!mark || !row.placedByActionId) continue;
    if (row.actionTaken === 'group_plan.report_released') {
      open.delete(mark.dedupeKey);
    } else if (!open.has(mark.dedupeKey) && mark.method && mark.gateUserId) {
      open.set(mark.dedupeKey, {
        familyId: row.familyId,
        placedByActionId: row.placedByActionId,
        familyEventId: mark.familyEventId,
        dedupeKey: mark.dedupeKey,
        method: mark.method,
        gateUserId: mark.gateUserId,
      });
    }
  }
  return [...open.values()];
}

/**
 * Records that this revision's group text waits for the morning. A key already held is
 * not held twice, so the hourly cancel retry can ask all night.
 */
export async function recordGroupPlanHold(
  database: Database,
  plan: GroupPlan,
  now: Date,
): Promise<void> {
  const open = await readOpenHolds(database, now, {
    familyId: plan.familyId,
    placedByActionId: plan.placedByActionId,
  });
  if (open.some((hold) => hold.dedupeKey === plan.dedupeKey)) return;
  await database.insert(schema.auditLog).values({
    familyId: plan.familyId,
    actor: 'system',
    actionTaken: 'group_plan.report_held',
    targetTable: 'actions',
    targetId: plan.placedByActionId,
    occurredAt: now,
    after: {
      familyEventId: plan.familyEventId,
      dedupeKey: plan.dedupeKey,
      method: plan.change === 'cancelled' ? 'CANCEL' : 'REQUEST',
      change: plan.change,
      gateUserId: plan.gateUserId,
    },
  });
}

/** The open holds whose key nothing has spent yet: a key sent by any caller is done. */
export async function selectOpenGroupPlanHolds(
  database: Database,
  now: Date,
): Promise<OpenGroupPlanHold[]> {
  const open = await readOpenHolds(database, now);
  if (open.length === 0) return [];
  const claimed = new Set(
    (
      await database
        .select({ dedupeKey: schema.channelMessages.dedupeKey })
        .from(schema.channelMessages)
        .where(
          inArray(
            schema.channelMessages.dedupeKey,
            open.map((hold) => hold.dedupeKey),
          ),
        )
    ).map((row) => row.dedupeKey),
  );
  return open.filter((hold) => !claimed.has(hold.dedupeKey));
}

function endedBy(report: CalendarInviteReport): Ended {
  if (report.status === 'reported') return 'toParents';
  if (report.status !== 'group_reported') return 'errored';
  switch (report.outcome) {
    case 'sent':
      return 'sent';
    case 'already_sent':
      return 'alreadySent';
    case 'held:quiet_hours':
      return 'heldAgain';
    case 'unwritten':
      return 'unwritten';
    case 'no_link':
      return 'noLink';
    default:
      return 'errored';
  }
}

async function redriveOne(
  database: Database,
  sender: CalendarInviteSender,
  hold: OpenGroupPlanHold,
  now: Date,
): Promise<Ended> {
  try {
    const row = await loadInviteEventRow(database, hold.familyEventId);
    if (!row || row.familyId !== hold.familyId) return 'gone';
    if (hold.method === 'REQUEST' && row.deletedAt !== null) return 'gone';
    if (row.startsAt.getTime() <= now.getTime()) return 'started';
    return endedBy(
      await sender.send({
        familyId: hold.familyId,
        familyEventId: hold.familyEventId,
        method: hold.method,
      }),
    );
  } catch (err) {
    console.error(
      { familyId: hold.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'group plan re-drive: threw - kept for the next morning',
    );
    return 'errored';
  }
}

export async function runGroupPlanReportRedrive(
  database: Database,
  deps: { sender: CalendarInviteSender },
  now: Date = new Date(),
): Promise<GroupPlanReportRedriveResult> {
  const result = emptyGroupPlanRedriveResult();

  const open = await selectOpenGroupPlanHolds(database, now);
  result.open = open.length;

  const due: OpenGroupPlanHold[] = [];
  for (const hold of open) {
    if (isRedriveSlot(now, await redriveParentTimeZone(database, hold.gateUserId))) due.push(hold);
  }
  result.due = due.length;
  result.deferred = Math.max(0, due.length - MAX_REDRIVE_PER_RUN);
  if (result.deferred > 0) {
    console.warn(
      { deferred: result.deferred, cap: MAX_REDRIVE_PER_RUN },
      'group plan re-drive: more held group texts than one run sends - the rest keep their place',
    );
  }

  for (const hold of due.slice(0, MAX_REDRIVE_PER_RUN)) {
    const ended = await redriveOne(database, deps.sender, hold, now);
    result[ended] += 1;
    if (ended !== 'heldAgain' && ended !== 'errored') await release(database, hold, ended, now);
  }

  return result;
}

/**
 * Closes a hold. One that fails to write is logged and comes back the next morning,
 * where a key already spent is skipped before anything is asked.
 */
async function release(database: Database, hold: OpenGroupPlanHold, ended: Ended, now: Date) {
  try {
    await database.insert(schema.auditLog).values({
      familyId: hold.familyId,
      actor: 'system',
      actionTaken: 'group_plan.report_released',
      targetTable: 'actions',
      targetId: hold.placedByActionId,
      occurredAt: now,
      after: { familyEventId: hold.familyEventId, dedupeKey: hold.dedupeKey, outcome: ended },
    });
  } catch (err) {
    console.error(
      { familyId: hold.familyId, ended, err: err instanceof Error ? err.name : 'unknown' },
      'group plan re-drive: could not release the hold - it comes back next morning',
    );
  }
}
