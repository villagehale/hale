import { and, eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import type { GuardDeps, GuardResult, MonetaryCost } from '@hale/agent';
import { deriveStage, DEFAULT_SAFETY_POLICY } from '@hale/types';

/**
 * The REAL GuardDeps for the Ask Hale agent — the hard rules wired to Postgres.
 * The harness runs these BEFORE any tool handler, so the safety rails are
 * rule-enforced, never agent-chosen (see packages/agent/src/tool.ts).
 *
 *   writeAudit             → an immutable audit_log row per tool call (rule #6)
 *   checkSpendingCap       → per-action spending cap (rule #7)
 *   checkChildContentAccess→ teen-redaction / consent at the tool boundary (rule #1/#5)
 *
 * `actor` on the audit row is the signed-in parent's user id (PIPEDA
 * right-to-access answers "who asked"). familyId scopes every check.
 */

/** Tool inputs that name a specific child — used to resolve the child for the teen check. */
function childIdFromInput(input: unknown): string | null {
  if (input && typeof input === 'object' && 'childId' in input) {
    const value = (input as { childId: unknown }).childId;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

export function buildGuardDeps(database: Database): GuardDeps {
  return {
    writeAudit: async (entry) => {
      await database.insert(schema.auditLog).values({
        familyId: entry.familyId,
        actor: entry.actor,
        actionTaken: entry.actionTaken,
        after: entry.after,
      });
    },

    checkSpendingCap: async (_familyId: string, cost: MonetaryCost): Promise<GuardResult> => {
      const caps = DEFAULT_SAFETY_POLICY.spendingCaps;
      if (caps.categoriesRequiringApproval.includes(cost.category)) {
        return {
          ok: false,
          reason: `category '${cost.category}' requires explicit approval`,
        };
      }
      if (cost.amountUsd > caps.perActionMaxUsd) {
        return {
          ok: false,
          reason: `amount ${cost.amountUsd} exceeds per-action cap of ${caps.perActionMaxUsd}`,
        };
      }
      return {
        ok: true,
        reason: `amount ${cost.amountUsd} within per-action cap of ${caps.perActionMaxUsd}`,
      };
    },

    monetaryCostOf: (toolName: string, input: unknown): MonetaryCost => {
      if (input && typeof input === 'object' && 'amountUsd' in input && 'category' in input) {
        const { amountUsd, category } = input as { amountUsd: unknown; category: unknown };
        if (typeof amountUsd === 'number' && typeof category === 'string') {
          return { amountUsd, category };
        }
      }
      throw new Error(`monetaryCostOf: tool '${toolName}' input carries no {amountUsd, category}`);
    },

    checkChildContentAccess: async (
      checkFamilyId: string,
      _toolName: string,
      input: unknown,
    ): Promise<GuardResult> => {
      const childId = childIdFromInput(input);
      if (!childId) {
        // No specific child named → no teen content to gate. Family-wide reads
        // are already family-scoped by the tool handler.
        return { ok: true, reason: 'no child-specific content requested' };
      }

      const rows = await database
        .select({ dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(
          and(
            eq(schema.children.id, childId),
            eq(schema.children.familyId, checkFamilyId),
          ),
        )
        .limit(1);

      const child = rows[0];
      if (!child) {
        // Unknown child id, or one belonging to a different family (rule #1):
        // fail closed — the agent never touches a child outside this family.
        return { ok: false, reason: 'child not found in this family' };
      }

      if (deriveStage(child.dateOfBirth) === 'teenager') {
        return {
          ok: false,
          reason: "teen content is redacted from parents by default (rule #1) — no time-limited grant on record",
        };
      }

      return { ok: true, reason: 'child is under 13 — profile access permitted' };
    },
  };
}
