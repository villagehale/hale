'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import {
  type DeleteResult,
  type EditResult,
  type LogResult,
  deleteEpisodeSchema,
  editEpisodeSchema,
  quickLogSchema,
  resolveOccurredAt,
} from './log-types.js';
import {
  buildEpisodeInsert,
  childBelongsToFamily,
  softDeleteEpisode,
  updateEpisode,
  writeEpisode,
} from './log-write.js';

/**
 * Quick-log server actions. A parent logging a feed, nap, or milestone — or
 * asking Hale to help book a health item — is a direct user action, so each
 * writes a family_memory_episodes row plus an immutable audit_log row in one
 * transaction (rule #6, in log-write).
 *
 * Rule #1: episodes are family-level care logs with no precise location; nothing
 * leaves the family, and a parent only ever logs against their own children
 * (childBelongsToFamily fails closed otherwise).
 *
 * Degrades to a preview (never a write, never a crash) when there is no
 * DATABASE_URL or no resolved family — mirroring the onboarding persist path.
 */

export async function logQuickEpisode(raw: unknown, now: Date = new Date()): Promise<LogResult> {
  const parsed = quickLogSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const occurredAt = resolveOccurredAt(parsed.data.occurredAt, now);
  if (!occurredAt.ok) {
    return { status: 'invalid', error: occurredAt.error };
  }

  if (!process.env.DATABASE_URL) {
    return { status: 'preview', reason: 'no_database' };
  }
  if (!authConfigured()) {
    return { status: 'preview', reason: 'no_auth' };
  }

  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return { status: 'preview', reason: 'no_auth' };
  }

  if (!(await childBelongsToFamily(database, familyId, parsed.data.childId))) {
    return { status: 'forbidden' };
  }

  await writeEpisode(database, buildEpisodeInsert(parsed.data, familyId, occurredAt.date));

  revalidatePath('/companion');
  revalidatePath('/home');
  return { status: 'logged' };
}

/**
 * Edits a parent's own logged episode from the dedicated logs view. Family-scoped
 * (rule #1): updateEpisode reconfirms the row belongs to this family and returns
 * false otherwise → 'forbidden' (never a silent success). The audit actor is the
 * acting parent (rule #6), so this resolves BOTH the family and the user id.
 * Degrades to preview (never a write) with no DATABASE_URL / no auth / no family.
 */
export async function editQuickEpisode(raw: unknown, now: Date = new Date()): Promise<EditResult> {
  const parsed = editEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const occurredAt = resolveOccurredAt(parsed.data.occurredAt, now);
  if (!occurredAt.ok) {
    return { status: 'invalid', error: occurredAt.error };
  }

  const scope = await resolveWriteScope();
  if (!scope) return { status: 'preview' };

  const ok = await updateEpisode(
    scope.database,
    parsed.data.id,
    scope.familyId,
    { summary: parsed.data.summary, occurredAt: occurredAt.date },
    scope.actorUserId,
  );
  if (!ok) return { status: 'forbidden' };

  revalidatePath('/companion');
  revalidatePath('/home');
  return { status: 'edited' };
}

/**
 * Soft-deletes a parent's own logged episode from the dedicated logs view. Same
 * family scoping + audit-actor discipline as editQuickEpisode; softDeleteEpisode
 * stamps deleted_at rather than erasing the row (rules #6, #9).
 */
export async function deleteQuickEpisode(
  raw: unknown,
  now: Date = new Date(),
): Promise<DeleteResult> {
  const parsed = deleteEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'invalid', error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const scope = await resolveWriteScope();
  if (!scope) return { status: 'preview' };

  const ok = await softDeleteEpisode(scope.database, parsed.data.id, scope.familyId, scope.actorUserId, now);
  if (!ok) return { status: 'forbidden' };

  revalidatePath('/companion');
  revalidatePath('/home');
  return { status: 'deleted' };
}

/**
 * Resolves the family AND the acting parent's user id for an audited mutation, or
 * null when the request is a preview (no DATABASE_URL / no auth / no session / no
 * mirrored user). Fails closed — never fabricates a family or actor (rule #1).
 */
async function resolveWriteScope(): Promise<{
  database: ReturnType<typeof defaultDb>;
  familyId: string;
  actorUserId: string;
} | null> {
  if (!process.env.DATABASE_URL || !authConfigured()) return null;

  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return null;

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return null;

  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!actorUserId) return null;

  return { database, familyId, actorUserId };
}
