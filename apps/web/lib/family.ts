import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { db as defaultDb } from '~/lib/db';
import { clerkConfigured } from '~/lib/auth-config';

/**
 * Resolves the current request's family from Clerk auth.
 *
 * Auth lives in Clerk; `users.external_auth_id` mirrors the Clerk user id, and
 * `family_members` links a user to their family. So the lookup is:
 *   clerk userId → users.external_auth_id → family_members.family_id
 *
 * Degrades to null (never a fake id, never a throw) when the signed-in Clerk
 * user has no mirrored `users` row / family membership yet (onboarding
 * incomplete). The caller renders the calm empty state.
 *
 * Dev-preview mode (Clerk not configured): there is no signed-in user to key
 * off, so we resolve the first family by creation order — the counterpart to
 * the layout's "auth disabled — development preview" banner. This NEVER runs in
 * production: if Clerk is somehow unconfigured in prod (misconfiguration), the
 * path fails CLOSED (returns null) rather than surfacing a family to an
 * unauthenticated request — rule #1, default to most restrictive.
 *
 * TODO: when a Clerk user belongs to more than one family, this picks the first
 * membership. Multi-family switching isn't wired yet; the families↔active-family
 * selection lands when that UI exists.
 */
export async function currentFamilyId(database: Database = defaultDb()): Promise<string | null> {
  if (!clerkConfigured()) {
    // Fail closed in production (rule #1): never surface a family to an
    // unauthenticated request if Clerk is missing in prod. The first-family
    // dev-preview fallback is for local screenshots/demo only.
    if (process.env.NODE_ENV === 'production') {
      return null;
    }
    return firstFamilyForDevPreview(database);
  }

  const { userId } = await auth();
  if (!userId) {
    return null;
  }

  return resolveFamilyForClerkUser(userId, database);
}

/**
 * Dev-preview family resolution: the earliest-created family. Used only when
 * Clerk is unconfigured (local screenshots / demo), never in production.
 */
async function firstFamilyForDevPreview(database: Database): Promise<string | null> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .orderBy(schema.families.createdAt)
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Pure-ish DB lookup: Clerk user id → family id. Extracted so the join logic is
 * unit-testable with an injected db. Returns null when the user has no mirrored
 * row or no family membership.
 */
export async function resolveFamilyForClerkUser(
  clerkUserId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.users)
    .innerJoin(schema.familyMembers, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.users.externalAuthId, clerkUserId))
    .limit(1);

  return rows[0]?.familyId ?? null;
}
