import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { type Tx, recordTransition } from './memory-writer.js';

/**
 * The internal (no-external-dispatch) executor writes: pinning an accepted
 * village item onto the family's week plan (add_to_routine) and noting it for the
 * daily digest (add_to_digest_only). Both land on `family_plans` — the parent's
 * real "your week" surface (loadAuthoredPlans / the Plan page) — differing only in
 * whether the item is dated onto the current week (a routine pin) or kept as an
 * undated note (a digest note). Each write and its immutable audit_log row share
 * ONE transaction via recordTransition (rule #6), and each is idempotent on a
 * re-drain: the audit row it wrote last time is the "already done" key, so a
 * redelivered job is a no-op rather than a double-post.
 */

/** The accepted-candidate fields the executor pins. Only the coarse village
 * fields ever reach here (rule #1: no precise location is stored on the row). */
interface RoutineItemInput {
  familyId: string;
  actionId: string;
  eventId: string;
  title: string;
  notes: string | null;
}

export type InternalWriteOutcome = 'written' | 'already_written';

/** The audit actions the two internal writes stamp — also the idempotency keys. */
const ROUTINE_PIN_ACTION = 'action.routine_pinned';
const DIGEST_NOTE_ACTION = 'action.digest_noted';

/**
 * Resolves the family's primary parent — the user the plan is attributed to
 * (family_plans.created_by is NOT NULL). Throws if none exists rather than
 * masking with a fabricated id (rule #8): a family that reached execution always
 * has a primary parent.
 */
async function primaryParentUserId(tx: Tx, familyId: string): Promise<string> {
  const rows = await tx
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  const userId = rows[0]?.userId;
  if (!userId) {
    throw new Error(
      `internal write: family ${familyId} has no primary_parent to attribute the plan to`,
    );
  }
  return userId;
}

/** The child this action's event concerns (nullable = whole-family plan). */
async function eventChildId(tx: Tx, eventId: string): Promise<string | null> {
  const rows = await tx
    .select({ childId: schema.events.childId })
    .from(schema.events)
    .where(eq(schema.events.id, eventId))
    .limit(1);
  return rows[0]?.childId ?? null;
}

/**
 * Has this action already written its internal plan row? The audit_log row from
 * the prior pass (keyed by action id + the specific audit action) is the
 * idempotency signal, so a re-drain never inserts a second family_plans row.
 */
async function alreadyWritten(tx: Tx, actionId: string, actionTaken: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.targetId, actionId), eq(schema.auditLog.actionTaken, actionTaken)),
    )
    .limit(1);
  return rows.length > 0;
}

async function pinToPlan(
  input: RoutineItemInput,
  auditAction: string,
  scheduledFor: Date | null,
  database: Database,
): Promise<InternalWriteOutcome> {
  return recordTransition(async (tx) => {
    if (await alreadyWritten(tx, input.actionId, auditAction)) {
      return {
        value: 'already_written' as const,
        // A no-op re-drain still records WHY nothing new was written (rule #6):
        // right-to-access shows the redelivery was suppressed, not lost.
        audit: {
          familyId: input.familyId,
          actor: 'system',
          actionTaken: `${auditAction}.skipped_duplicate`,
          targetTable: 'actions',
          targetId: input.actionId,
          after: {
            reason: 'internal write already applied on a prior pass — redelivery suppressed',
          },
        },
      };
    }

    const createdBy = await primaryParentUserId(tx, input.familyId);
    const childId = await eventChildId(tx, input.eventId);

    const inserted = await tx
      .insert(schema.familyPlans)
      .values({
        familyId: input.familyId,
        createdBy,
        childId,
        title: input.title,
        notes: input.notes,
        scheduledFor,
      })
      .returning({ id: schema.familyPlans.id });
    const planId = inserted[0]?.id;
    if (!planId) {
      throw new Error('internal write: family_plans insert returned no row');
    }

    return {
      value: 'written' as const,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: auditAction,
        targetTable: 'family_plans',
        targetId: planId,
        after: {
          actionId: input.actionId,
          title: input.title,
          childId,
          scheduledFor: scheduledFor?.toISOString() ?? null,
        },
      },
    };
  }, database);
}

/**
 * add_to_routine — pin the accepted village item onto the CURRENT week (dated to
 * `now`, so loadAuthoredPlans lays it on this week's spine). Idempotent + audited.
 */
export function addToRoutine(
  input: RoutineItemInput,
  now: Date = new Date(),
  database: Database = db(),
): Promise<InternalWriteOutcome> {
  return pinToPlan(input, ROUTINE_PIN_ACTION, now, database);
}

/**
 * add_to_digest_only — record the item as an UNDATED plan note (scheduled_for
 * null). It surfaces on the plan's undated bucket, and because the executed
 * action flips to user_visible_state='autonomous' it is counted by the daily
 * digest tally. Idempotent + audited.
 */
export function addToDigest(
  input: RoutineItemInput,
  database: Database = db(),
): Promise<InternalWriteOutcome> {
  return pinToPlan(input, DIGEST_NOTE_ACTION, null, database);
}

// ─── calendar placements (VIL-219) ───────────────────────────────────────
//
// calendar_add / calendar_move / calendar_cancel write Hale's OWN family_events
// (source='placement'), NOT the dormant Google Calendar seam. Each write shares
// ONE transaction with its audit row (rule #6) and is idempotent on a re-drain.
// calendar_add returns the new family_events id as the REVERSAL HANDLE — the
// executor nests it in `detail`, so it lands in actions.executor_result and the
// UNDO primitive (apps/web/lib/actions/reverse-calendar.ts) can find the row to
// soft-delete. calendar_move mutates that row; calendar_cancel soft-deletes it.

/** The fields a calendar_add places. Only surname-free titles reach here (rule #1);
 * the teen age gate genericizes a 13+ child's title at read (ICS / plan). */
export interface CalendarPlacementInput {
  familyId: string;
  actionId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  childId: string | null;
  /** Health-sensitive placement — stamped onto family_events.sensitive so reminders
   * genericize the copy for everyone (VIL-223). */
  sensitive: boolean;
}

/** calendar_move: the target row (reversalHandle) plus its new time/title/place. */
export interface CalendarMoveInput {
  familyId: string;
  actionId: string;
  reversalHandle: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
}

/** calendar_cancel: just the target row to soft-delete. */
export interface CalendarCancelInput {
  familyId: string;
  actionId: string;
  reversalHandle: string;
}

/** The family_events row a placement write landed on (the reversal handle). */
export interface CalendarWriteResult {
  outcome: InternalWriteOutcome;
  familyEventId: string;
}

const CALENDAR_PLACED_ACTION = 'action.calendar_placed';
const CALENDAR_MOVED_ACTION = 'action.calendar_moved';
const CALENDAR_CANCELLED_ACTION = 'action.calendar_cancelled';

/**
 * The family_events id a prior pass of THIS action wrote for THIS operation, or
 * null. Doubles as the idempotency signal (non-null ⇒ already applied) AND the
 * re-drain recovery of the same handle — the success audit stamps the row id as
 * its targetId and the action id in `after.actionId`, so a redelivery returns the
 * original row instead of writing a second one.
 */
async function priorPlacementEventId(
  tx: Tx,
  actionId: string,
  auditAction: string,
): Promise<string | null> {
  const rows = await tx
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, auditAction),
        sql`${schema.auditLog.after} ->> 'actionId' = ${actionId}`,
      ),
    )
    .limit(1);
  return rows[0]?.targetId ?? null;
}

/** A no-op re-drain still records WHY nothing new was written (rule #6). */
function placementSkippedAudit(familyId: string, actionId: string, auditAction: string) {
  return {
    familyId,
    actor: 'system' as const,
    actionTaken: `${auditAction}.skipped_duplicate`,
    targetTable: 'actions',
    targetId: actionId,
    after: { reason: 'calendar placement already applied on a prior pass — redelivery suppressed' },
  };
}

/**
 * calendar_add — insert a Hale-authored placement into family_events. Returns the
 * new row id (the reversal handle). Idempotent + audited; a re-drain recovers the
 * original id rather than inserting a duplicate.
 */
export function addToCalendar(
  input: CalendarPlacementInput,
  database: Database = db(),
): Promise<CalendarWriteResult> {
  return recordTransition<CalendarWriteResult>(async (tx) => {
    const prior = await priorPlacementEventId(tx, input.actionId, CALENDAR_PLACED_ACTION);
    if (prior) {
      return {
        value: { outcome: 'already_written' as const, familyEventId: prior },
        audit: placementSkippedAudit(input.familyId, input.actionId, CALENDAR_PLACED_ACTION),
      };
    }

    const inserted = await tx
      .insert(schema.familyEvents)
      .values({
        familyId: input.familyId,
        childId: input.childId,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        location: input.location,
        source: 'placement',
        sensitive: input.sensitive,
      })
      .returning({ id: schema.familyEvents.id });
    const familyEventId = inserted[0]?.id;
    if (!familyEventId) {
      throw new Error('addToCalendar: family_events insert returned no row');
    }

    return {
      value: { outcome: 'written' as const, familyEventId },
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: CALENDAR_PLACED_ACTION,
        targetTable: 'family_events',
        targetId: familyEventId,
        after: {
          actionId: input.actionId,
          title: input.title,
          childId: input.childId,
          startsAt: input.startsAt.toISOString(),
        },
      },
    };
  }, database);
}

/**
 * calendar_move — re-time / re-title an existing placement (the reversalHandle
 * row). The UPDATE is family-scoped and skips soft-deleted rows; a missing/deleted
 * target throws (rule #8 — a move of a nonexistent placement is a real failure,
 * not a silent success). Idempotent + audited.
 */
export function moveCalendarEvent(
  input: CalendarMoveInput,
  database: Database = db(),
): Promise<CalendarWriteResult> {
  return recordTransition<CalendarWriteResult>(async (tx) => {
    const prior = await priorPlacementEventId(tx, input.actionId, CALENDAR_MOVED_ACTION);
    if (prior) {
      return {
        value: { outcome: 'already_written' as const, familyEventId: prior },
        audit: placementSkippedAudit(input.familyId, input.actionId, CALENDAR_MOVED_ACTION),
      };
    }

    const updated = await tx
      .update(schema.familyEvents)
      .set({
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        location: input.location,
      })
      .where(
        and(
          eq(schema.familyEvents.id, input.reversalHandle),
          eq(schema.familyEvents.familyId, input.familyId),
          isNull(schema.familyEvents.deletedAt),
        ),
      )
      .returning({ id: schema.familyEvents.id });
    const familyEventId = updated[0]?.id;
    if (!familyEventId) {
      throw new Error(
        `moveCalendarEvent: no live family_events row ${input.reversalHandle} for family ${input.familyId}`,
      );
    }

    return {
      value: { outcome: 'written' as const, familyEventId },
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: CALENDAR_MOVED_ACTION,
        targetTable: 'family_events',
        targetId: familyEventId,
        after: { actionId: input.actionId, startsAt: input.startsAt.toISOString() },
      },
    };
  }, database);
}

/**
 * calendar_cancel — soft-delete an existing placement (the reversalHandle row).
 * The row survives with deleted_at set so the audit trail + an UNDO stay intact
 * (rules #6/#9). Family-scoped; a missing/already-deleted target throws (rule #8).
 * Idempotent + audited.
 */
export function cancelCalendarEvent(
  input: CalendarCancelInput,
  now: Date = new Date(),
  database: Database = db(),
): Promise<CalendarWriteResult> {
  return recordTransition<CalendarWriteResult>(async (tx) => {
    const prior = await priorPlacementEventId(tx, input.actionId, CALENDAR_CANCELLED_ACTION);
    if (prior) {
      return {
        value: { outcome: 'already_written' as const, familyEventId: prior },
        audit: placementSkippedAudit(input.familyId, input.actionId, CALENDAR_CANCELLED_ACTION),
      };
    }

    const updated = await tx
      .update(schema.familyEvents)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.familyEvents.id, input.reversalHandle),
          eq(schema.familyEvents.familyId, input.familyId),
          isNull(schema.familyEvents.deletedAt),
        ),
      )
      .returning({ id: schema.familyEvents.id });
    const familyEventId = updated[0]?.id;
    if (!familyEventId) {
      throw new Error(
        `cancelCalendarEvent: no live family_events row ${input.reversalHandle} for family ${input.familyId}`,
      );
    }

    return {
      value: { outcome: 'written' as const, familyEventId },
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: CALENDAR_CANCELLED_ACTION,
        targetTable: 'family_events',
        targetId: familyEventId,
        after: { actionId: input.actionId },
      },
    };
  }, database);
}
