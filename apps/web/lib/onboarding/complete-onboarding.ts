'use server';

import { type Database, schema } from '@hale/db';
import { type PlanTier, parseIntents } from '@hale/types';
import { eq } from 'drizzle-orm';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { recordConsent } from '~/lib/consent';
import { ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import {
  type LocationInput,
  isOnboardingRegionSupported,
  normalizeLocation,
} from '~/lib/family/location-input';
import { type ChildInput, type ValidatedChild, validateChild } from './children';
import { provisionAndWriteChildren } from './persist';
import { type WelcomeDeps, sendWelcomeEmail } from './send-welcome';
import { type DiscoveryTrigger, defaultDiscoveryTrigger } from './trigger-discovery';

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

/** The consents asked for, and given, at sign-up. terms + privacy are the policy
 * acceptance; cross-border + LLM cover that sensitive processing runs on US AI
 * infrastructure (both disclosed in the Privacy Policy as consented at sign-up). */
const CONSENTS_AT_SIGNUP = [
  'terms_of_service',
  'privacy_policy',
  'cross_border_data',
  'llm_processing',
] as const satisfies ReadonlyArray<schema.NewConsentRecord['consentType']>;

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
  /**
   * Optional onboarding intents (OnboardingIntent values). Unknown / duplicate
   * values are dropped; an empty selection is stored as null (column is nullable).
   */
  intents?: string[];
}

export type CompleteOnboardingResult =
  | { status: 'completed'; familyId: string }
  | { status: 'preview' }
  | { status: 'region_unavailable' }
  | { status: 'invalid'; error: string };

export async function completeOnboarding(
  input: CompleteOnboardingInput,
  welcomeDeps?: WelcomeDeps,
  discoveryTrigger: DiscoveryTrigger = defaultDiscoveryTrigger(),
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
  const location = normalizeLocation(input.location ?? {});
  // Compliance gate (hard rule #1): Hale is cleared to onboard Canada only. An
  // explicit non-Canadian country is blocked HERE — before any child PII (a full
  // DOB) is persisted — until that market's GDPR/COPPA + data residency are in
  // place. Broadening is a deliberate per-market program, never an assumption.
  if (!isOnboardingRegionSupported(location.country)) {
    return { status: 'region_unavailable' };
  }
  const intents = parseIntents(input.intents ?? []);
  const familyUpdate = {
    planTier: input.planTier,
    country: location.country,
    province: location.province,
    city: location.city,
    postalCode: location.postalCode,
    areaCoarse: location.areaCoarse,
    intents: intents.length > 0 ? intents : null,
  };

  // One atomic transaction. Provisioning (the child PII, incl. DOB) and the
  // consent records commit together — a crash anywhere rolls back BOTH, so a
  // child's data can never be left in the DB without its consent row (rule #1,
  // rule #6). The consents reference the family id, so they are recorded once the
  // family exists (the FK is immediate); a crash before COMMIT discards both.
  const { familyId, userId } = await database.transaction(async (tx) => {
    const executor = tx as unknown as Database;
    const familyId =
      existingFamilyId ??
      (
        await provisionAndWriteChildren(
          executor,
          identity,
          validated.map((child) => ({
            name: child.name,
            lastName: child.lastName,
            dateOfBirth: child.dateOfBirth,
            gender: child.gender,
          })),
        )
      ).familyId;

    const userId = await ensureUserRow(identity, executor);

    await tx.update(schema.families).set(familyUpdate).where(eq(schema.families.id, familyId));

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

    // The consents the user gives at sign-up, each stamped with the policy
    // version + time (the Privacy Policy promises a verifiable record). Sign-up
    // is where we ask for terms + privacy, and — because all sensitive
    // processing runs on US AI infra — cross-border + LLM processing too.
    for (const consentType of CONSENTS_AT_SIGNUP) {
      await recordConsent(tx, { userId, familyId, consentType, granted: true });
    }

    return { familyId, userId };
  });

  // The one-time welcome email, fired now that the family + children exist (so it
  // can be personalized and point at a ready village). Idempotent via the send
  // ledger, so a second completion/login does not re-send. Transactional, so it
  // is NOT held behind the digest send flag. A send failure must NOT fail
  // onboarding — swallow it at this boundary only (CLAUDE.md #8 boundary catch).
  try {
    await sendWelcomeEmail(database, { userId, familyId, email, name: identity.name }, welcomeDeps);
  } catch (err) {
    console.error('welcome email failed (onboarding unaffected)', err);
  }

  // Populate the family's village NOW (in the background) so it isn't blank on
  // first view — the engine reads only the coarse area just written (rule #1) and
  // runs the same discovery the cron does. Scheduling must not throw into the
  // completion path; a failure degrades to the existing empty state (rule #8).
  // Populate the family's village NOW (in the background) so it isn't blank on
  // first view — the engine reads only the coarse area just written (rule #1) and
  // runs the same discovery the cron does. Scheduling must not throw into the
  // completion path; a failure degrades to the existing empty state (rule #8).
  try {
    discoveryTrigger(familyId, database);
  } catch (err) {
    console.error('first-village discovery trigger failed (onboarding unaffected)', err);
  }

  return { status: 'completed', familyId };
}
