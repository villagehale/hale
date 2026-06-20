'use server';

import { schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { eq } from 'drizzle-orm';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { type ChildInput, validateChild } from './children';
import { provisionAndWriteChildren } from './persist';

/**
 * The intake-first onboarding completion (Phase C). Runs only AFTER Google
 * sign-in + ToS acceptance, so this is the first point at which sensitive child
 * data (full date of birth) is collected or persisted (rule #1) — Phase A holds
 * only a non-sensitive month estimate in the browser.
 *
 * It provisions the first-time parent's family + children via the existing
 * audited path (provisionAndWriteChildren), then records the chosen plan tier and
 * the ToS acceptance. ToS acceptance is its own immutable audit_log row (rule #6)
 * so PIPEDA right-to-access can show exactly when consent was given.
 *
 * No charge is taken — the plan choice is captured on the family; billing is a
 * later concern. Degrades to `preview` at the two expected boundaries (no
 * DATABASE_URL, auth unconfigured / not signed in) without writing or crashing.
 */

const PLAN_TIERS: readonly PlanTier[] = ['free', 'plus', 'family'];

function isPlanTier(value: string): value is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(value);
}

export interface CompleteOnboardingInput {
  child: ChildInput;
  planTier: string;
  tosAccepted: boolean;
  /** Optional coarse area (postal-area / neighbourhood) — never a precise address (rule #1). */
  areaCoarse?: string;
}

export type CompleteOnboardingResult =
  | { status: 'completed'; familyId: string }
  | { status: 'preview' }
  | { status: 'invalid'; error: string };

export async function completeOnboarding(
  input: CompleteOnboardingInput,
): Promise<CompleteOnboardingResult> {
  if (!input.tosAccepted) {
    return { status: 'invalid', error: 'tos_required' };
  }
  if (!isPlanTier(input.planTier)) {
    return { status: 'invalid', error: 'plan_invalid' };
  }

  const validated = validateChild(input.child);
  if (!validated.ok) {
    return { status: 'invalid', error: validated.error };
  }

  if (!process.env.DATABASE_URL || !authConfigured()) {
    return { status: 'preview' };
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  const email = session?.user?.email;
  if (!externalAuthId || !email) {
    return { status: 'preview' };
  }

  const database = defaultDb();
  const identity = { externalAuthId, email, name: session.user?.name ?? null };

  const existingFamilyId = await resolveFamilyForUser(externalAuthId, database);
  const familyId =
    existingFamilyId ??
    (
      await provisionAndWriteChildren(database, identity, [
        { name: validated.child.name, dateOfBirth: validated.child.dateOfBirth },
      ])
    ).familyId;

  const userId = await ensureUserRow(identity, database);
  const area = input.areaCoarse?.trim();
  const familyUpdate: { planTier: PlanTier; areaCoarse?: string } = { planTier: input.planTier };
  if (area) {
    familyUpdate.areaCoarse = area;
  }

  await database.transaction(async (tx) => {
    await tx
      .update(schema.families)
      .set(familyUpdate)
      .where(eq(schema.families.id, familyId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'tos_accepted',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: input.planTier },
    });
  });

  return { status: 'completed', familyId };
}
