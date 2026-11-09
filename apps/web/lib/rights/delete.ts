import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { type CoParentDeparted, departCoParent } from '../channel/coparent/depart.js';
import {
  type UndecodableIntakeOutcome,
  erasedFamilyHolds,
  redactErasedIntake,
  releaseErasedHolds,
} from '../channel/intake/opt-out-hold.js';
import { removeDocument } from '../docs/storage.js';
import {
  type ErasureGoogleOutcome,
  type ErasureSettlement,
  GOOGLE_REVOKE_PENDING_RETENTION_MS,
  endGoogleForFamilyErasure,
} from '../integrations/google-disconnect.js';
import { CONNECTOR_PROVIDERS, type ConnectorProvider } from '../integrations/google-oauth.js';
import {
  type FailurePageCounts,
  pageErasureGoogleUnconfirmed,
  recordErasureGoogleUnconfirmed,
  releaseErasedCrisisMarks,
} from '../monitoring/failure-page.js';
import { type OrphanSweepSummary, runOrphanUserSweep } from './orphan-users.js';

export {
  MESSAGE_RETENTION_BATCH,
  MESSAGE_RETENTION_DAYS,
  type MessageRetentionSummary,
  sweepMessageRetention,
} from './message-retention.js';

/**
 * PIPEDA / Law 25 right-to-erasure, REVERSIBLE BY GRACE. A confirm-gated request
 * does NOT hard-delete: it STAMPS families.scheduled_deletion_at at now + a grace
 * window and writes the audit row (rule #6). The worker hard-deletes the family
 * only once now() passes the stamp; until then, clearing the stamp cancels the
 * deletion — so an accidental or coerced request is recoverable.
 */

/** The grace window before the worker erases a scheduled family, in days. */
export const DELETION_GRACE_DAYS = 7;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

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

type FamilyRole = (typeof schema.familyMembers.$inferSelect)['role'];

/**
 * What an erasure request turned out to mean. Three outcomes, never folded into one
 * another (rule #11): a co-parent's request erases THEM, and the caller owes them a
 * different sentence from the one a scheduled family gets — there is no grace window
 * to name, because nothing of the household was scheduled — while a seat with no
 * erasure of its own is refused outright and carries the role it was refused for, so
 * the route can say 403 rather than guess.
 */
export type ErasureRequest =
  | { outcome: 'family_scheduled'; scheduledDeletionAt: Date }
  | { outcome: 'co_parent_departed'; departure: CoParentDeparted }
  | { outcome: 'not_permitted'; role: FamilyRole | null };

/**
 * VIL-355 · the right-to-erasure door, which has two sides.
 *
 * Until now there was one: every request stamped the FAMILY, because the sweep is the
 * only erasure that existed. For the primary parent that is right — the household is
 * theirs and the grace window makes it recoverable. For a co-parent it was the wrong
 * answer to the right question: they asked to be erased, and Hale would have scheduled
 * the children's whole history, the other parent's included, for deletion.
 *
 * So the role decides, read from `family_members` rather than inferred from the session:
 * the primary parent schedules the family, a co-parent gets {@link departCoParent}, and
 * EVERYTHING ELSE IS REFUSED.
 *
 * The refusal is the second half of the fix, not an aside. `grandparent`, `nanny` and
 * `babysitter` are scoped redaction levels, they sign in by claiming their number, and
 * this door has no role gate above it — so a babysitter's "delete my account" used to
 * stamp the children's entire history for deletion, with nothing telling the parent it
 * had happened. A scoped seat's own leave door is a separate question; answering it
 * with the household's erasure is the one answer that can never be right, so this
 * fails closed and names the role it refused.
 */
export async function requestErasure(
  database: Database,
  args: ScheduleFamilyDeletionArgs,
): Promise<ErasureRequest> {
  const { familyId, actorUserId } = args;
  const now = args.now ?? new Date();

  const [seat] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.userId, actorUserId),
      ),
    );

  if (!seat || (seat.role !== 'co_parent' && seat.role !== 'primary_parent')) {
    // The refusal is recorded, not just returned. Rule #6 speaks of actions and a
    // refusal is not one — but "nobody asked" and "somebody asked and was told no" are
    // different facts about a household, and only one of them was ever findable. The
    // role is the whole payload: no number, no name, nothing from the request.
    await database.insert(schema.auditLog).values({
      familyId,
      actor: actorUserId,
      actionTaken: 'erasure_refused',
      targetTable: 'family_members',
      targetId: actorUserId,
      after: { role: seat?.role ?? null },
    });
    return { outcome: 'not_permitted', role: seat?.role ?? null };
  }

  if (seat.role === 'co_parent') {
    const departure = await departCoParent(database, { familyId, actorUserId, now });
    // The seat was read and claimed in two statements, so a departure that lost the
    // race between them found nothing to remove. Nothing is erased and nothing is
    // scheduled — the request is answered by the state it found, never by falling
    // through to the family sweep, which would erase the household on a retry.
    if (departure.outcome !== 'departed') {
      throw new Error(`requestErasure: co-parent seat vanished mid-request (${departure.outcome})`);
    }
    return { outcome: 'co_parent_departed', departure };
  }

  return {
    outcome: 'family_scheduled',
    ...(await scheduleFamilyDeletion(database, { familyId, actorUserId, now })),
  };
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
  /** What the same run did about people no household holds a seat for any more. Nested
   * rather than flattened so a zero here reads as "nobody was orphaned", never as a
   * count somebody forgot to add (rule #11). */
  orphans: OrphanSweepSummary;
  /** How many storage objects (chat attachments + child avatars) had their bytes
   * purged from the private bucket across the run — the caller logs it so the
   * byte-level erasure is recorded durably (rule #6 note below). */
  purgedObjects: number;
  /** Families due for erasure kept for a later sweep because Google has not yet answered
   * a revoke of their grant (VIL-156). Named, never folded into `erased`. */
  googleRevokePending: number;
  /** Families kept because ending their Google grants locally threw. Named, and they never
   * hold the other families' erasure. */
  googleEndFailed: number;
  /** Families erased although Google never confirmed, because their wait ran out: the
   * erasure promise wins. Each one's counts-only page claim commits with its DELETE, and
   * `page` is what paging them at the end of this run did. */
  pastGoogleWait: {
    unconfirmed: number;
    endFailed: number;
    /** `page_failed`: the pager threw; each claim stays owed for the failure-page cron. */
    page: FailurePageCounts | 'nothing_to_page' | 'page_failed';
  };
  /** Every Google row of every due family, by outcome, kept or erased. */
  google: ErasureGoogleRow[];
  /** Intake sessions of the erased families that would not decode, and the page about them.
   * Such a session never stops the erasure: zero sessions is `nothing_to_page`. */
  undecodableIntake: UndecodableIntakeOutcome;
}

/** A Google row of a due family. Past the wait, `google_unconfirmed` is a revoke Google
 * never answered and `google_end_failed` a row whose local end kept throwing; the cascade
 * deletes either row, its keys and its pending token with it. */
export interface ErasureGoogleRow {
  integrationId: string;
  provider: ConnectorProvider;
  google: ErasureGoogleOutcome | 'google_unconfirmed' | 'google_end_failed';
}

/**
 * The Google half of a sweep summary as the cron logs it: counts and outcome codes only,
 * never a family, user or integration id. Null when the sweep touched no Google row.
 */
export function erasureGoogleLogLine(summary: DeletionSweepSummary) {
  const { googleRevokePending, googleEndFailed, pastGoogleWait } = summary;
  if (summary.google.length === 0 && googleRevokePending === 0 && googleEndFailed === 0) {
    return null;
  }
  const google: Partial<Record<ErasureGoogleRow['google'], number>> = {};
  for (const row of summary.google) google[row.google] = (google[row.google] ?? 0) + 1;
  return { googleRevokePending, googleEndFailed, pastGoogleWait, google };
}

/** Pages #ops with every owed erasure claim (failure-page.ts). */
type PageErasureGoogle = () => Promise<FailurePageCounts>;

/**
 * How long a due family is kept waiting for Google: its scheduled deletion plus the same
 * seven days a pending revoke token lives. Past that the family is erased whatever Google
 * says, so the deletion window has an end.
 */
async function pastGoogleWaitFor(database: Database, familyId: string, now: Date) {
  const [row] = await database
    .select({ at: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  if (!row?.at) return false;
  return now.getTime() - row.at.getTime() >= GOOGLE_REVOKE_PENDING_RETENTION_MS;
}

/** The family's Google rows when its local end threw: named per row before the cascade. */
async function googleRowsOf(database: Database, familyId: string) {
  const rows = await database
    .select({ id: schema.integrations.id, provider: schema.integrations.provider })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        inArray(schema.integrations.provider, CONNECTOR_PROVIDERS),
        or(
          isNotNull(schema.integrations.oauthTokensEncrypted),
          isNotNull(schema.integrations.googleRevokePendingEncrypted),
        ),
      ),
    );
  return rows.map((row) => ({
    integrationId: row.id,
    provider: row.provider as ConnectorProvider,
  }));
}

/** The storage-object remover, injected so tests record deletes without a live bucket. */
type RemoveObject = (path: string) => Promise<void>;

/**
 * Removes every storage object a family owns from the private 'family-docs' bucket,
 * across BOTH prefixes the family ever wrote: chat attachments (chat/{familyId}/…)
 * and child avatars (avatars/{familyId}/{childId}). Each row carries a direct
 * family_id, so the scope is a single WHERE — no join. Child avatars are the most
 * sensitive asset class Hale holds (rule #1), so a stranded child photo surviving
 * account erasure is the gravest gap: a child's avatar_path is enumerated the same
 * way, and because the key is deterministic and removeObject tolerates a 404, a
 * re-run is safe. Returns the object count so the sweep can report it. The FK
 * cascade erases these ROWS when the family is deleted, but never the BYTES — that
 * is this function's job.
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
  const avatars = await database
    .select({ storagePath: schema.children.avatarPath })
    .from(schema.children)
    .where(and(eq(schema.children.familyId, familyId), isNotNull(schema.children.avatarPath)));

  // avatar_path is a nullable column; the isNotNull filter above excludes children
  // with no photo, and this narrows the remaining paths to string (never masks a real
  // path — a null here is a child that never had an avatar object).
  const paths = [...attachments, ...avatars]
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
  pageErasureGoogle: PageErasureGoogle = () => pageErasureGoogleUnconfirmed(database, { now }),
): Promise<DeletionSweepSummary> {
  const due = await selectFamiliesDueForDeletion(database, now);
  // FIRST, because the cascade deletes keys and pending tokens and deleting a key revokes
  // nothing: each family's Google grants are ended and revoked at Google (VIL-156). A
  // revoke Google has not answered keeps the family for a later sweep, and so does a local
  // end that throws, but only until the family's wait runs out (pastGoogleWaitFor). Past
  // it the family is erased in this sweep, each such row is named, and #ops is paged.
  // Everything below runs on `familyIds`, the families this run deletes, and never on one
  // it keeps.
  const familyIds: string[] = [];
  const google: ErasureGoogleRow[] = [];
  let googleRevokePending = 0;
  let googleEndFailed = 0;
  const pastWait = { unconfirmed: 0, endFailed: 0 };
  const erasedPastWait = new Map<string, { unconfirmed: number; endFailed: number }>();
  for (const familyId of due) {
    let settled: ErasureSettlement[] | null = null;
    try {
      settled = await endGoogleForFamilyErasure(database, familyId);
    } catch (err) {
      // The error class only: the family is being erased, and the sweep counts it.
      console.error(
        { error: err instanceof Error ? err.name : 'unknown' },
        'deletion sweep: google end failed',
      );
    }
    const waiting = settled === null || settled.some((row) => row.google === 'pending_retry');
    if (!waiting) {
      google.push(...(settled ?? []).map(({ push: _push, ...row }) => row));
      familyIds.push(familyId);
      continue;
    }
    if (!(await pastGoogleWaitFor(database, familyId, now))) {
      if (settled === null) googleEndFailed += 1;
      else googleRevokePending += 1;
      google.push(...(settled ?? []).map(({ push: _push, ...row }) => row));
      continue;
    }
    erasedPastWait.set(familyId, {
      unconfirmed: settled === null ? 0 : 1,
      endFailed: settled === null ? 1 : 0,
    });
    if (settled === null) {
      pastWait.endFailed += 1;
      for (const row of await googleRowsOf(database, familyId)) {
        google.push({ ...row, google: 'google_end_failed' });
      }
    } else {
      pastWait.unconfirmed += 1;
      for (const { push: _push, ...row } of settled) {
        google.push(
          row.google === 'pending_retry' ? { ...row, google: 'google_unconfirmed' } : row,
        );
      }
    }
    familyIds.push(familyId);
  }
  // READ BEFORE THE DELETES, because the delete is what destroys it. `parent_channels`
  // cascades from `families`, and that row is the orphan sweep's whole evidence that a
  // person ever held a channel — so a parent erased below is invisible to a sweep that
  // runs afterwards, and their name, address and sign-in identity survive the erasure
  // they asked for. These ids are that evidence, carried across the cascade by hand.
  const stranded =
    familyIds.length === 0
      ? []
      : [
          ...new Set(
            (
              await database
                .select({ userId: schema.parentChannels.userId })
                .from(schema.parentChannels)
                .where(inArray(schema.parentChannels.familyId, familyIds))
            ).map((row) => row.userId),
          ),
        ];

  // VIL-553 · held opt-out reads are keyed by the number and the text alone, out of the
  // cascade's reach. Read before the delete, like `stranded`.
  const erasedHolds = await erasedFamilyHolds(database, familyIds);
  // Their crisis claims and reply marks are keyed by the texts the cascade deletes, and by
  // the pre-signup texts only their intake transcripts name.
  await releaseErasedCrisisMarks(database, familyIds, erasedHolds.intakeInboundIds);
  // Their pre-signup intake has no family for the cascade to reach.
  await redactErasedIntake(database, erasedHolds, now);

  // A shared chat's people rows only SET NULL on the family delete, which would keep the
  // erased family's numbers and first names as anonymous rows.
  if (familyIds.length > 0) {
    await database
      .delete(schema.linqSharedGroupPeople)
      .where(inArray(schema.linqSharedGroupPeople.familyId, familyIds));
  }

  let purgedObjects = 0;
  for (const familyId of familyIds) {
    purgedObjects += await purgeFamilyStorage(database, familyId, removeObject);
    const unconfirmed = erasedPastWait.get(familyId);
    if (unconfirmed === undefined) {
      await database.delete(schema.families).where(eq(schema.families.id, familyId));
      continue;
    }
    // The page's record commits with the DELETE: a throw later in this sweep cannot lose
    // it, and a DELETE that fails records nothing.
    await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await recordErasureGoogleUnconfirmed(tx, unconfirmed);
      await tx.delete(schema.families).where(eq(schema.families.id, familyId));
    });
  }
  const undecodableIntake = await releaseErasedHolds(database, erasedHolds);
  // AFTER the families, and on the same tick rather than a cron of its own: an erasure
  // that just removed a household is the commonest way a person is orphaned, so running
  // second means this run cleans up after itself instead of leaving it for the next hour.
  //
  // After rather than before is also the safe half of the ordering: the sweep ANONYMISES
  // a users row, which nothing undoes, and a purge that throws leaves its family standing
  // for the next run to retry. Sweeping first would strip a parent whose household is
  // still there. The cost is that these people's audit rows have nowhere to live — see
  // `sweptWithoutTrail`, which is counted and logged rather than quietly skipped.
  const orphans = await runOrphanUserSweep(database, now, stranded);
  // The claims were recorded with each DELETE above; this pages them now. A page that does
  // not leave stays owed for the failure-page cron, and a pager that throws is named here
  // rather than skipping the cron's later retention sweeps.
  let page: DeletionSweepSummary['pastGoogleWait']['page'] = 'nothing_to_page';
  if (erasedPastWait.size > 0) {
    try {
      page = await pageErasureGoogle();
    } catch (err) {
      page = 'page_failed';
      console.error(
        { error: err instanceof Error ? err.name : 'unknown' },
        'deletion sweep: erasure google page threw',
      );
    }
  }
  return {
    erased: familyIds.length,
    purgedObjects,
    googleRevokePending,
    googleEndFailed,
    pastGoogleWait: { ...pastWait, page },
    google,
    orphans,
    undecodableIntake,
  };
}
