'use server';

import { auth, currentUser } from '@clerk/nextjs/server';
import { type Database, schema } from '@hale/db';
import type { FamilyStage } from '@hale/types';
import { clerkConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { type ClerkIdentity, ensureUserRow, resolveFamilyForClerkUser } from '~/lib/family';
import { type ChildInput, buildChildInserts, unionStages, validateChild } from './children';

/**
 * Persists the onboarding children for a family.
 *
 * The experience is for families across all of childhood, so this writes one
 * row per child with its date_of_birth — the only source of truth. No stage is
 * stored; the dashboard derives it live.
 *
 * Degradation (mirrors the dashboard read path and the approve route): when
 * Clerk is unconfigured (dev preview) OR there is no DATABASE_URL, the wizard
 * still validates and previews the derived stages, but NOTHING is written and
 * we return `preview` — never a fabricated family id, never a crash.
 *
 * For a signed-in parent whose family does NOT yet resolve, this is their first
 * onboarding: we provision their `users` row, a `families` row, and their
 * `primary_parent` membership (rule #5), then write the children — all in one
 * transaction with the family-creation audit row (rule #6). A parent whose
 * family already resolves just gets the children written to it (no second
 * family).
 */

export type OnboardingResult =
  | { status: 'saved'; familyId: string; childCount: number; stages: FamilyStage[] }
  | { status: 'preview'; reason: 'no_database' | 'no_auth'; stages: FamilyStage[] }
  | { status: 'invalid'; index: number; error: string };

export async function saveOnboardingChildren(
  inputs: ReadonlyArray<ChildInput>,
  now: Date = new Date(),
): Promise<OnboardingResult> {
  const validated: { name: string; dateOfBirth: string; stage: FamilyStage }[] = [];
  for (const [index, input] of inputs.entries()) {
    const result = validateChild(input, now);
    if (!result.ok) {
      return { status: 'invalid', index, error: result.error };
    }
    validated.push(result.child);
  }

  const stages = unionStages(validated);

  if (!process.env.DATABASE_URL) {
    return { status: 'preview', reason: 'no_database', stages };
  }
  if (!clerkConfigured()) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const { userId } = await auth();
  if (!userId) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const database = defaultDb();
  const existingFamilyId = await resolveFamilyForClerkUser(userId, database);
  if (existingFamilyId) {
    await writeChildren(database, existingFamilyId, validated);
    return { status: 'saved', familyId: existingFamilyId, childCount: validated.length, stages };
  }

  const identity = await clerkIdentity(userId);
  const { familyId } = await provisionAndWriteChildren(database, identity, validated);
  return { status: 'saved', familyId, childCount: validated.length, stages };
}

/**
 * Reads the signed-in parent's email + name from Clerk, the source of truth for
 * the mirrored `users` row. Throws if Clerk has no current user or no primary
 * email — provisioning a family with a fabricated or missing identity would
 * violate rule #1, so we fail loudly rather than mask it (CLAUDE.md #8).
 */
async function clerkIdentity(clerkUserId: string): Promise<ClerkIdentity> {
  const user = await currentUser();
  if (!user) {
    throw new Error('clerkIdentity: auth() returned a userId but currentUser() is null');
  }
  const email = user.primaryEmailAddress?.emailAddress;
  if (!email) {
    throw new Error(`clerkIdentity: Clerk user ${clerkUserId} has no primary email address`);
  }
  return { clerkUserId, email, name: user.fullName };
}

/**
 * Provisions a brand-new family for a first-time parent and writes their
 * children, all in ONE transaction so a partial provisioning (a family with no
 * member, or a member with no family) can never be observed. The order is:
 * mirror the `users` row, create the `families` row, link the parent as
 * `primary_parent` (rule #5), write the children, and stamp the family-creation
 * audit row (rule #6). New families default to L1 observe-only (rule #4) via the
 * `observation_mode` onboarding stage. Country/language/plan-tier are left to the
 * schema defaults (CA / en / free).
 *
 * Exported for unit tests; the request path goes through saveOnboardingChildren.
 */
export async function provisionAndWriteChildren(
  database: Database,
  identity: ClerkIdentity,
  children: ReadonlyArray<{ name: string; dateOfBirth: string }>,
): Promise<{ familyId: string }> {
  return database.transaction(async (tx) => {
    const userId = await ensureUserRow(identity, tx as unknown as Database);

    const inserted = await tx
      .insert(schema.families)
      .values({
        displayName: familyDisplayName(identity.name),
        onboardingStage: 'observation_mode',
      })
      .returning({ id: schema.families.id });

    const familyId = inserted[0]?.id;
    if (!familyId) {
      throw new Error('provisionAndWriteChildren: families insert returned no row');
    }

    await tx.insert(schema.familyMembers).values({ familyId, userId, role: 'primary_parent' });

    await writeChildren(tx as unknown as Database, familyId, children);

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'family_created',
      targetTable: 'families',
      targetId: familyId,
    });

    return { familyId };
  });
}

/**
 * The family's display name from the parent's name: `${firstName}'s family`,
 * falling back to a neutral default when Clerk carries no name. firstName is the
 * leading whitespace-delimited token of the full name.
 */
function familyDisplayName(name: string | null): string {
  const firstName = name?.trim().split(/\s+/)[0];
  return firstName ? `${firstName}'s family` : 'Your family';
}

async function writeChildren(
  database: Database,
  familyId: string,
  children: ReadonlyArray<{ name: string; dateOfBirth: string }>,
): Promise<void> {
  const rows = buildChildInserts(familyId, children).map((row) => ({
    familyId: row.familyId,
    name: row.name,
    dateOfBirth: row.dateOfBirth,
  }));
  await database.insert(schema.children).values(rows);
}
