'use server';

import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { type AuthIdentity, ensureUserRow, resolveFamilyForUser } from '~/lib/family';
import {
  type PlanInput,
  type PlanValidationError,
  insertPlanForFamily,
  validatePlan,
} from './plan-core';

/**
 * Parent-authored plans behind the Plan ("your week") page: create and delete a
 * private plan. Each mutation resolves the caller's family from the Auth.js
 * session (never a fabricated id — rule #1), family-scopes the write, and writes
 * an immutable audit_log row alongside the mutation (rule #6). The family-scoping
 * and audit live in plan-core (insertPlanForFamily) so they're unit-testable
 * without a request. Plans are private-only; public discovery is a deferred
 * build, so nothing here exposes a publish/visibility flag.
 *
 * Degradation mirrors children-actions: no DATABASE_URL or auth-unconfigured (dev
 * preview) returns `preview` — nothing is written, never a crash.
 */

export type CreatePlanResult =
  | { status: 'created' }
  | { status: 'preview' }
  | { status: 'not_found' }
  | { status: 'foreign_child' }
  | { status: 'invalid'; error: PlanValidationError };

export async function createPlan(input: PlanInput): Promise<CreatePlanResult> {
  const validated = validatePlan(input);
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

  const result = await insertPlanForFamily(database, { familyId, userId, plan: validated.plan });
  if (result.status === 'foreign_child') {
    return { status: 'foreign_child' };
  }

  revalidatePath('/plan');
  return { status: 'created' };
}

export type DeletePlanResult =
  | { status: 'deleted' }
  | { status: 'preview' }
  | { status: 'not_found' };

export async function deletePlan(planId: string): Promise<DeletePlanResult> {
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

  const deleted = await database.transaction(async (tx) => {
    // Scope the delete to the caller's family (rule #1): a planId from another
    // family must not be deletable. The where(familyId) makes that structural.
    const existing = await tx
      .select({ title: schema.familyPlans.title })
      .from(schema.familyPlans)
      .where(and(eq(schema.familyPlans.id, planId), eq(schema.familyPlans.familyId, familyId)))
      .limit(1);
    const before = existing[0];
    if (!before) {
      return false;
    }

    await tx
      .delete(schema.familyPlans)
      .where(and(eq(schema.familyPlans.id, planId), eq(schema.familyPlans.familyId, familyId)));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'plan_deleted',
      targetTable: 'family_plans',
      targetId: planId,
      before,
    });
    return true;
  });

  if (!deleted) {
    return { status: 'not_found' };
  }
  revalidatePath('/plan');
  return { status: 'deleted' };
}

type MutationContext =
  | { status: 'ready'; database: Database; identity: AuthIdentity }
  | { status: 'preview' };

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
