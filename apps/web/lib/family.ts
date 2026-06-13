import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { type Database, schema } from '@haru/db';
import { db as defaultDb } from '~/lib/db';
import { clerkConfigured } from '~/lib/auth-config';

/**
 * Resolves the current request's family from Clerk auth.
 *
 * Auth lives in Clerk; `users.external_auth_id` mirrors the Clerk user id, and
 * `family_members` links a user to their family. So the lookup is:
 *   clerk userId → users.external_auth_id → family_members.family_id
 *
 * Degrades to null (never a fake id, never a throw) in two cases:
 *   - Clerk is not configured (dev preview) — there is no signed-in user.
 *   - The signed-in Clerk user has no mirrored `users` row / family membership
 *     yet (onboarding incomplete). The caller renders the calm empty state.
 *
 * TODO: when a Clerk user belongs to more than one family, this picks the first
 * membership. Multi-family switching isn't wired yet; the families↔active-family
 * selection lands when that UI exists.
 */
export async function currentFamilyId(database: Database = defaultDb()): Promise<string | null> {
  if (!clerkConfigured()) {
    return null;
  }

  const { userId } = await auth();
  if (!userId) {
    return null;
  }

  return resolveFamilyForClerkUser(userId, database);
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
