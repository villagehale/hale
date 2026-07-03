import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';

/**
 * Pure + injectable core for parent-authored plans, kept OUT of the 'use server'
 * module (which may only export async server actions) so it can export sync
 * helpers and a db-injectable insert, and be unit-tested without a request. The
 * 'use server' actions in plan-actions.ts wrap these with auth + family
 * resolution.
 */

export interface PlanInput {
  title: string;
  notes: string | null;
  /** ISO datetime the plan is scheduled for, or null. */
  scheduledFor: string | null;
  /** A child in the caller's family, or null for a whole-family plan. */
  childId: string | null;
}

export type ValidatedPlan = {
  title: string;
  notes: string | null;
  scheduledFor: Date | null;
  childId: string | null;
};

export type PlanValidationError = 'title_required' | 'scheduled_for_invalid';

export function validatePlan(
  input: PlanInput,
): { ok: true; plan: ValidatedPlan } | { ok: false; error: PlanValidationError } {
  const title = input.title.trim();
  if (title.length === 0) {
    return { ok: false, error: 'title_required' };
  }
  const notes = input.notes?.trim() ? input.notes.trim() : null;

  let scheduledFor: Date | null = null;
  if (input.scheduledFor) {
    const parsed = new Date(input.scheduledFor);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'scheduled_for_invalid' };
    }
    scheduledFor = parsed;
  }

  return {
    ok: true,
    plan: { title, notes, scheduledFor, childId: input.childId },
  };
}

export type InsertPlanResult =
  | { status: 'created'; planId: string }
  | { status: 'foreign_child' };

/**
 * Family-scope and persist a validated plan. When a childId is given, it must
 * belong to `familyId` — otherwise the write is rejected (foreign_child), never
 * inserted (rule #1). The plan insert and its audit_log row (rule #6) share one
 * transaction, so an audit row exists for every created plan. `private` is not
 * passed — the column defaults true (the only mode today).
 */
export async function insertPlanForFamily(
  database: Database,
  args: { familyId: string; userId: string; plan: ValidatedPlan },
): Promise<InsertPlanResult> {
  const { familyId, userId, plan } = args;

  return database.transaction(async (tx) => {
    if (plan.childId !== null) {
      const owned = await tx
        .select({ id: schema.children.id })
        .from(schema.children)
        .where(and(eq(schema.children.id, plan.childId), eq(schema.children.familyId, familyId)))
        .limit(1);
      if (!owned[0]) {
        return { status: 'foreign_child' } as const;
      }
    }

    const inserted = await tx
      .insert(schema.familyPlans)
      .values({
        familyId,
        createdBy: userId,
        childId: plan.childId,
        title: plan.title,
        notes: plan.notes,
        scheduledFor: plan.scheduledFor,
      })
      .returning({ id: schema.familyPlans.id });
    const planId = inserted[0]?.id;
    if (!planId) {
      throw new Error('insertPlanForFamily: family_plans insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'plan_created',
      targetTable: 'family_plans',
      targetId: planId,
      after: {
        title: plan.title,
        childId: plan.childId,
        scheduledFor: plan.scheduledFor?.toISOString() ?? null,
        private: true,
      },
    });

    return { status: 'created', planId } as const;
  });
}
