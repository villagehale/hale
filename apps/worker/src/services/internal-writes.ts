import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
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
