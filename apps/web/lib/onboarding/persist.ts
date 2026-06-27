'use server';

import { type Database, schema } from '@hale/db';
import type { ChildGender, FamilyStage } from '@hale/types';
import type { Session } from 'next-auth';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { type AuthIdentity, ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { type ChildInput, buildChildInserts, unionStages, validateChild } from './children';

/**
 * Persists the onboarding children for a family.
 *
 * The experience is for families across all of childhood, so this writes one
 * row per child with its date_of_birth — the only source of truth. No stage is
 * stored; the dashboard derives it live.
 *
 * Degradation (mirrors the dashboard read path and the approve route): when auth
 * is unconfigured (dev preview) OR there is no DATABASE_URL, the wizard still
 * validates and previews the derived stages, but NOTHING is written and we return
 * `preview` — never a fabricated family id, never a crash.
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
  const validated: {
    name: string;
    lastName: string | null;
    dateOfBirth: string;
    stage: FamilyStage;
    gender: ChildGender;
  }[] = [];
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
  if (!authConfigured()) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const session = await auth();
  if (!session?.user?.id) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const database = defaultDb();
  const existingFamilyId = await resolveFamilyForUser(session.user.id, database);
  if (existingFamilyId) {
    await writeChildren(database, existingFamilyId, validated);
    return { status: 'saved', familyId: existingFamilyId, childCount: validated.length, stages };
  }

  const identity = authIdentity(session);
  const { familyId } = await database.transaction((tx) =>
    provisionAndWriteChildren(tx as unknown as Database, identity, validated),
  );
  return { status: 'saved', familyId, childCount: validated.length, stages };
}

/**
 * Reads the signed-in parent's external id + email + name from the Auth.js
 * session (the Google profile), the source of truth for the mirrored `users` row.
 * Throws if the session carries no id or no email — provisioning a family with a
 * fabricated or missing identity would violate rule #1, so we fail loudly rather
 * than mask it (CLAUDE.md #8).
 */
function authIdentity(session: Session): AuthIdentity {
  const externalAuthId = session.user?.id;
  const email = session.user?.email;
  if (!externalAuthId) {
    throw new Error('authIdentity: session has no user id');
  }
  if (!email) {
    throw new Error(`authIdentity: session user ${externalAuthId} has no email address`);
  }
  return { externalAuthId, email, name: session.user?.name ?? null };
}

/**
 * Provisions a brand-new family for a first-time parent and writes their
 * children. The caller supplies the executor (a transaction handle) so this runs
 * inside ONE transaction with whatever else the caller commits atomically — for
 * onboarding completion, the consent records (rule #1, rule #6), so a crash can
 * never leave a child's data (incl. DOB) persisted without its consent row. The
 * order is: mirror the `users` row, create the `families` row, link the parent as
 * `primary_parent` (rule #5), write the children, and stamp the family-creation
 * audit row (rule #6). A partial provisioning (a family with no member, or a
 * member with no family) can never be observed because the executor's transaction
 * either commits all of it or none. New families default to L1 observe-only (rule
 * #4) via the `observation_mode` onboarding stage. Country/language/plan-tier are
 * left to the schema defaults (CA / en / free).
 *
 * Exported for unit tests; the request path goes through saveOnboardingChildren.
 */
export async function provisionAndWriteChildren(
  tx: Database,
  identity: AuthIdentity,
  children: ReadonlyArray<ChildPersist>,
): Promise<{ familyId: string }> {
  const userId = await ensureUserRow(identity, tx);

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

  await writeChildren(tx, familyId, children);

  await tx.insert(schema.auditLog).values({
    familyId,
    actor: userId,
    actionTaken: 'family_created',
    targetTable: 'families',
    targetId: familyId,
  });

  return { familyId };
}

/**
 * The family's display name from the parent's name: `${firstName}'s family`,
 * falling back to a neutral default when the profile carries no name. firstName is
 * the leading whitespace-delimited token of the full name.
 */
function familyDisplayName(name: string | null): string {
  const firstName = name?.trim().split(/\s+/)[0];
  return firstName ? `${firstName}'s family` : 'Your family';
}

/** The child fields the persist path needs: the source-of-truth columns only. */
type ChildPersist = {
  name: string;
  lastName: string | null;
  dateOfBirth: string;
  gender: ChildGender;
};

async function writeChildren(
  database: Database,
  familyId: string,
  children: ReadonlyArray<ChildPersist>,
): Promise<void> {
  const rows = buildChildInserts(familyId, children);
  await database.insert(schema.children).values(rows);
}
