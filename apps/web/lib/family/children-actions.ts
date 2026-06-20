'use server';

import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { type AuthIdentity, ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import { provisionAndWriteChildren } from '~/lib/onboarding/persist';
import { type PlanTier, parseIntents } from '@hale/types';
import {
  type ChildError,
  type ChildInput,
  parseInterests,
  validateChild,
} from './children-input';
import { type LocationInput, normalizeLocation } from './location-input';

/**
 * The family-management mutations behind the Family page: add / edit / remove a
 * child, set the family's structured (coarse) location, set the plan tier, and
 * update the parent's display name. Each one validates, resolves the caller's
 * family from the Auth.js session (never a fabricated id — rule #1), and writes an
 * immutable audit_log row alongside the mutation (rule #6). Each mutation
 * revalidates /settings so the page re-reads after a write.
 *
 * Degradation mirrors saveOnboardingChildren: no DATABASE_URL or auth-unconfigured
 * (dev preview) returns `preview` — nothing is written, never a crash. A signed-in
 * parent whose family doesn't resolve yet on add-child gets one provisioned (the
 * audited provisioning path), so the Family page works for a first-time parent.
 */

export type AddChildResult =
  | { status: 'added' }
  | { status: 'preview' }
  | { status: 'invalid'; error: ChildError };

export async function addChildAction(input: ChildInput): Promise<AddChildResult> {
  const validated = validateChild(input);
  if (!validated.ok) {
    return { status: 'invalid', error: validated.error };
  }

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  const interests = parseInterests(input.interests);

  if (!familyId) {
    await provisionAndWriteChildren(database, identity, [
      { name: validated.child.name, dateOfBirth: validated.child.dateOfBirth },
    ]);
    revalidatePath('/settings');
    return { status: 'added' };
  }

  const userId = await ensureUserRow(identity, database);
  await database.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.children)
      .values({
        familyId,
        name: validated.child.name,
        dateOfBirth: validated.child.dateOfBirth,
        interests,
      })
      .returning({ id: schema.children.id });
    const childId = inserted[0]?.id;
    if (!childId) {
      throw new Error('addChildAction: children insert returned no row');
    }
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'child_added',
      targetTable: 'children',
      targetId: childId,
    });
  });

  revalidatePath('/settings');
  return { status: 'added' };
}

export type EditChildResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'not_found' }
  | { status: 'invalid'; error: ChildError };

export async function editChildAction(
  childId: string,
  input: ChildInput,
): Promise<EditChildResult> {
  const validated = validateChild(input);
  if (!validated.ok) {
    return { status: 'invalid', error: validated.error };
  }

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  const updated = await database.transaction(async (tx) => {
    // Scope the update to the caller's family (rule #1): a childId from another
    // family must not be editable. The where(familyId) makes that structural.
    const existing = await tx
      .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
      .limit(1);
    const before = existing[0];
    if (!before) {
      return false;
    }

    await tx
      .update(schema.children)
      .set({ name: validated.child.name, dateOfBirth: validated.child.dateOfBirth })
      .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'child_updated',
      targetTable: 'children',
      targetId: childId,
      before,
      after: { name: validated.child.name, dateOfBirth: validated.child.dateOfBirth },
    });
    return true;
  });

  if (!updated) {
    return { status: 'not_found' };
  }
  revalidatePath('/settings');
  return { status: 'updated' };
}

export type RemoveChildResult =
  | { status: 'removed' }
  | { status: 'preview' }
  | { status: 'not_found' };

export async function removeChildAction(childId: string): Promise<RemoveChildResult> {
  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  const removed = await database.transaction(async (tx) => {
    // Scope the delete to the caller's family (rule #1): a childId from another
    // family must not be removable. The where(familyId) makes that structural.
    const existing = await tx
      .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
      .limit(1);
    const before = existing[0];
    if (!before) {
      return false;
    }

    await tx
      .delete(schema.children)
      .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'child_removed',
      targetTable: 'children',
      targetId: childId,
      before,
    });
    return true;
  });

  if (!removed) {
    return { status: 'not_found' };
  }
  revalidatePath('/settings');
  return { status: 'removed' };
}

export type SetLocationResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'not_found' };

export async function setLocationAction(input: LocationInput): Promise<SetLocationResult> {
  const location = normalizeLocation(input);

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({
        country: schema.families.country,
        province: schema.families.province,
        city: schema.families.city,
        postalCode: schema.families.postalCode,
        areaCoarse: schema.families.areaCoarse,
      })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    await tx
      .update(schema.families)
      .set({
        country: location.country,
        province: location.province,
        city: location.city,
        postalCode: location.postalCode,
        areaCoarse: location.areaCoarse,
      })
      .where(eq(schema.families.id, familyId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'family_location_updated',
      targetTable: 'families',
      targetId: familyId,
      before: existing[0] ?? null,
      after: {
        country: location.country,
        province: location.province,
        city: location.city,
        postalCode: location.postalCode,
        areaCoarse: location.areaCoarse,
      },
    });
  });

  revalidatePath('/settings');
  return { status: 'updated' };
}

const PLAN_TIERS: readonly PlanTier[] = ['free', 'plus', 'family'];

function isPlanTier(value: string): value is PlanTier {
  return (PLAN_TIERS as readonly string[]).includes(value);
}

export type SetPlanResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'not_found' }
  | { status: 'invalid' };

export async function setPlanAction(planTier: string): Promise<SetPlanResult> {
  if (!isPlanTier(planTier)) {
    return { status: 'invalid' };
  }

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    await tx
      .update(schema.families)
      .set({ planTier })
      .where(eq(schema.families.id, familyId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: existing[0]?.planTier ?? null },
      after: { planTier },
    });
  });

  revalidatePath('/settings');
  return { status: 'updated' };
}

export type SetIntentsResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'not_found' };

/**
 * Sets the family's onboarding intents (what the parent hopes Hale can help
 * with). Unknown / duplicate values are dropped (parseIntents); an empty
 * selection clears the column to null. Audits family_intents_updated (rule #6).
 */
export async function setIntentsAction(rawIntents: string[]): Promise<SetIntentsResult> {
  const parsed = parseIntents(rawIntents);
  const intents = parsed.length > 0 ? parsed : null;

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ intents: schema.families.intents })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    await tx
      .update(schema.families)
      .set({ intents })
      .where(eq(schema.families.id, familyId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'family_intents_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { intents: existing[0]?.intents ?? null },
      after: { intents },
    });
  });

  revalidatePath('/settings');
  return { status: 'updated' };
}

export type SetParentNameResult =
  | { status: 'updated' }
  | { status: 'preview' }
  | { status: 'not_found' }
  | { status: 'invalid' };

export async function setParentNameAction(rawName: string): Promise<SetParentNameResult> {
  const name = rawName.trim();
  if (name.length === 0) {
    return { status: 'invalid' };
  }

  const ctx = await mutationContext();
  if (ctx.status === 'preview') {
    return { status: 'preview' };
  }

  const { database, identity } = ctx;
  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    await tx.update(schema.users).set({ name }).where(eq(schema.users.id, userId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'parent_name_updated',
      targetTable: 'users',
      targetId: userId,
      before: { name: existing[0]?.name ?? null },
      after: { name },
    });
  });

  revalidatePath('/settings');
  return { status: 'updated' };
}

type MutationContext =
  | { status: 'ready'; database: Database; identity: AuthIdentity }
  | { status: 'preview' };

/**
 * Resolves the signed-in parent's identity + a db handle for a mutation, or
 * `preview` at the two expected boundaries (no DATABASE_URL, auth unconfigured /
 * not signed in). Never fabricates an identity (rule #1).
 */
async function mutationContext(): Promise<MutationContext> {
  if (!process.env.DATABASE_URL || !authConfigured()) {
    return { status: 'preview' };
  }
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const email = session?.user?.email;
  if (!externalAuthId || !email) {
    return { status: 'preview' };
  }
  return {
    status: 'ready',
    database: defaultDb(),
    identity: { externalAuthId, email, name: session.user?.name ?? null },
  };
}
