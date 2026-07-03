import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull, lte } from 'drizzle-orm';

/**
 * PIPEDA / Law 25 right-to-erasure, REVERSIBLE BY GRACE. A confirm-gated request
 * does NOT hard-delete: it STAMPS families.scheduled_deletion_at at now + a grace
 * window and writes the audit row (rule #6). The worker hard-deletes the family
 * only once now() passes the stamp; until then, clearing the stamp cancels the
 * deletion — so an accidental or coerced request is recoverable.
 */

/** The grace window before the worker erases a scheduled family — 7 days. */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScheduleFamilyDeletionArgs {
  familyId: string;
  /** The parent making the request (users.id) — the audit actor (rule #6). */
  actorUserId: string;
  now?: Date;
}

/**
 * Schedules the family for erasure. Idempotent: a family already scheduled keeps
 * its original date (no re-stamp, no second audit row), so a double-submit doesn't
 * push the window out or double-log. Returns the effective deletion instant.
 */
export async function scheduleFamilyDeletion(
  database: Database,
  args: ScheduleFamilyDeletionArgs,
): Promise<{ scheduledDeletionAt: Date }> {
  const { familyId, actorUserId } = args;
  const now = args.now ?? new Date();

  const rows = await database
    .select({ scheduledDeletionAt: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    throw new Error(`scheduleFamilyDeletion: no family row for ${familyId}`);
  }
  if (existing.scheduledDeletionAt) {
    return { scheduledDeletionAt: existing.scheduledDeletionAt };
  }

  const scheduledDeletionAt = new Date(now.getTime() + DELETION_GRACE_MS);

  await database
    .update(schema.families)
    .set({ scheduledDeletionAt })
    .where(eq(schema.families.id, familyId));

  await database.insert(schema.auditLog).values({
    familyId,
    actor: actorUserId,
    actionTaken: 'account_deletion_scheduled',
    targetTable: 'families',
    targetId: familyId,
    after: { scheduledDeletionAt },
  });

  return { scheduledDeletionAt };
}

/** Families whose scheduled_deletion_at has elapsed — the ones to erase now. */
export async function selectFamiliesDueForDeletion(
  database: Database,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(
      and(
        isNotNull(schema.families.scheduledDeletionAt),
        lte(schema.families.scheduledDeletionAt, now),
      ),
    );
  return rows.map((r) => r.id);
}

export interface DeletionSweepSummary {
  erased: number;
}

/**
 * The closing leg of the reversible-by-grace deletion: hard-delete every family
 * whose grace window has elapsed. A single DELETE per family — the families FK
 * cascade erases all of that family's data at once (the point of the cascade
 * posture). Idempotent by construction: a family erased on one run is gone, so a
 * re-run simply finds fewer due families.
 *
 * Audit note (rule #6): the erasure DECISION is durably audited at request time
 * (account_deletion_scheduled lives for the whole grace period). A family-scoped
 * audit row written here would cascade away with the family, so the execution is
 * recorded in the platform log by the caller (family id only, no PII) rather than
 * in a row that deletes itself. A detached, cascade-exempt audit sink for the
 * final erasure is a separate schema change.
 */
export async function runDeletionSweep(
  database: Database,
  now: Date = new Date(),
): Promise<DeletionSweepSummary> {
  const familyIds = await selectFamiliesDueForDeletion(database, now);
  for (const familyId of familyIds) {
    await database.delete(schema.families).where(eq(schema.families.id, familyId));
  }
  return { erased: familyIds.length };
}
