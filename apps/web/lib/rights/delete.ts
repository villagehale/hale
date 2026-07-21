import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { removeDocument } from '../docs/storage.js';

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
  /** How many storage objects (chat attachments + child documents) had their bytes
   * purged from the private bucket across the run — the caller logs it so the
   * byte-level erasure is recorded durably (rule #6 note below). */
  purgedObjects: number;
}

/** The storage-object remover, injected so tests record deletes without a live bucket. */
type RemoveObject = (path: string) => Promise<void>;

/**
 * Removes every storage object a family owns from the private 'family-docs' bucket,
 * across ALL THREE prefixes the family ever wrote: chat attachments (chat/{familyId}/…),
 * child documents ({familyId}/{docId}), and child avatars (avatars/{familyId}/{childId}).
 * Each row carries a direct family_id, so the scope is a single WHERE — no join. Child
 * documents are swept regardless of deleted_at: a per-doc soft-delete removes its bytes
 * only AFTER its own commit, so a crash there can strand an object a soft-deleted row
 * still points at — the family erase must reclaim it (removeObject tolerates a 404 for
 * the already-gone ones). Child avatars are the most sensitive asset class Hale holds
 * (rule #1), so a stranded child photo surviving account erasure is the gravest gap: a
 * child's avatar_path is enumerated the same way, and because the key is deterministic
 * and removeObject tolerates a 404, a re-run is safe. Returns the object count so the
 * sweep can report it. The FK cascade erases these ROWS when the family is deleted, but
 * never the BYTES — that is this function's job.
 */
async function purgeFamilyStorage(
  database: Database,
  familyId: string,
  removeObject: RemoveObject,
): Promise<number> {
  const attachments = await database
    .select({ storagePath: schema.chatAttachments.storagePath })
    .from(schema.chatAttachments)
    .where(eq(schema.chatAttachments.familyId, familyId));
  const documents = await database
    .select({ storagePath: schema.childDocuments.storagePath })
    .from(schema.childDocuments)
    .where(eq(schema.childDocuments.familyId, familyId));
  const avatars = await database
    .select({ storagePath: schema.children.avatarPath })
    .from(schema.children)
    .where(and(eq(schema.children.familyId, familyId), isNotNull(schema.children.avatarPath)));

  // avatar_path is a nullable column; the isNotNull filter above excludes children
  // with no photo, and this narrows the remaining paths to string (never masks a real
  // path — a null here is a child that never had an avatar object).
  const paths = [...attachments, ...documents, ...avatars]
    .map((row) => row.storagePath)
    .filter((path): path is string => path !== null);
  for (const path of paths) {
    await removeObject(path);
  }
  return paths.length;
}

/**
 * The closing leg of the reversible-by-grace deletion: hard-delete every family
 * whose grace window has elapsed. Per family the bytes go BEFORE the row —
 * purgeFamilyStorage empties the bucket, THEN a single DELETE drops the family and
 * the FK cascade erases its rows in one shot (the point of the cascade posture).
 * The cascade only ever removes ROWS, so without the purge the family's storage
 * objects would outlive the account (the erasure gap this closes, rule #1 / PIPEDA
 * right-to-erasure). Idempotent by construction: a family erased on one run is gone,
 * so a re-run simply finds fewer due families.
 *
 * Ordering is load-bearing (rule #8): a storage failure throws out of the purge
 * before the DELETE, so the family row is untouched and the next sweep retries the
 * whole erase — bytes can never be stranded with no row pointing at them. Never
 * catch-and-continue past a purge failure; that would delete the pointer and orphan
 * the object forever.
 *
 * Audit note (rule #6): the erasure DECISION is durably audited at request time
 * (account_deletion_scheduled lives for the whole grace period). A family-scoped
 * audit row written here would cascade away with the family, so the execution —
 * including the purged-object count — is recorded in the platform log by the caller
 * (family id + counts only, no PII) rather than in a row that deletes itself. A
 * detached, cascade-exempt audit sink for the final erasure is a separate schema
 * change.
 */
export async function runDeletionSweep(
  database: Database,
  now: Date = new Date(),
  removeObject: RemoveObject = removeDocument,
): Promise<DeletionSweepSummary> {
  const familyIds = await selectFamiliesDueForDeletion(database, now);
  let purgedObjects = 0;
  for (const familyId of familyIds) {
    purgedObjects += await purgeFamilyStorage(database, familyId, removeObject);
    // Device push tokens are user-scoped (push_tokens.user_id → users.id), so the
    // family DELETE's FK cascade never reaches them — a device address would outlive
    // the erased account (rule #1 / PIPEDA). Drop the family's members' tokens here.
    const memberIds = (
      await database
        .select({ userId: schema.familyMembers.userId })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId))
    ).map((row) => row.userId);
    if (memberIds.length > 0) {
      await database
        .delete(schema.pushTokens)
        .where(inArray(schema.pushTokens.userId, memberIds));
    }
    await database.delete(schema.families).where(eq(schema.families.id, familyId));
  }
  return { erased: familyIds.length, purgedObjects };
}
