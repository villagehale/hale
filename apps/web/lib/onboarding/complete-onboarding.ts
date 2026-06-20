'use server';

import { schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { eq } from 'drizzle-orm';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { type LocationInput, normalizeLocation } from '~/lib/family/location-input';
import { type ChildInput, type ValidatedChild, validateChild } from './children';
import { provisionAndWriteChildren } from './persist';

/**
 * The intake-first onboarding completion (Phase C). Runs only AFTER Google
 * sign-in + ToS acceptance, so this is the first point at which sensitive child
 * data (full dates of birth) is collected or persisted (rule #1) — Phase A holds
 * only non-sensitive first names + a coarse city in the browser.
 *
 * It provisions the first-time parent's family + children via the existing
 * audited path (provisionAndWriteChildren), records the chosen plan tier and the
 * structured (coarse) location, optionally updates the parent's display name (the
 * Google name, confirmed/edited by the parent), and writes the ToS acceptance as
 * its own immutable audit_log row (rule #6) so PIPEDA right-to-access can show
 * exactly when consent was given.
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
  /** One or more children, each with a full DOB (collected once, post-auth). */
  children: ChildInput[];
  planTier: string;
  tosAccepted: boolean;
  /** Structured, coarse location (rule #1) — never a precise address. */
  location?: LocationInput;
  /**
   * The parent's display name, prefilled from the Google profile and confirmed /
   * edited in setup. Trimmed; an empty value leaves the mirrored name unchanged.
   */
  parentName?: string;
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
  if (input.children.length === 0) {
    return { status: 'invalid', error: 'name_required' };
  }

  const validated: ValidatedChild[] = [];
  for (const child of input.children) {
    const result = validateChild(child);
    if (!result.ok) {
      return { status: 'invalid', error: result.error };
    }
    validated.push(result.child);
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
  const parentName = input.parentName?.trim();
  const identity = {
    externalAuthId,
    email,
    name: parentName && parentName.length > 0 ? parentName : (session.user?.name ?? null),
  };

  const existingFamilyId = await resolveFamilyForUser(externalAuthId, database);
  const familyId =
    existingFamilyId ??
    (
      await provisionAndWriteChildren(
        database,
        identity,
        validated.map((child) => ({ name: child.name, dateOfBirth: child.dateOfBirth })),
      )
    ).familyId;

  const userId = await ensureUserRow(identity, database);
  const location = normalizeLocation(input.location ?? {});
  const familyUpdate = {
    planTier: input.planTier,
    country: location.country,
    province: location.province,
    city: location.city,
    postalCode: location.postalCode,
    areaCoarse: location.areaCoarse,
  };

  await database.transaction(async (tx) => {
    await tx
      .update(schema.families)
      .set(familyUpdate)
      .where(eq(schema.families.id, familyId));

    if (parentName && parentName.length > 0) {
      await tx
        .update(schema.users)
        .set({ name: parentName })
        .where(eq(schema.users.id, userId));
    }

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
