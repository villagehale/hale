import { type Database, schema } from '@hale/db';
import { REVIEWER_TOOLS, type ReviewerToolName } from '@hale/tools-contracts';
import { DEFAULT_SAFETY_POLICY } from '@hale/types';
import type { ToolResult } from '@hale/types';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';

/**
 * Web-side reviewer verification tools — the SAME contract the worker enforces
 * (hard rule #3: the reviewer must invoke real checks, never approve on prose),
 * implemented against the same Postgres tables but with the Database INJECTED so
 * this stays inside apps/web (we never import worker src). Each tool validates its
 * input via the shared @hale/tools-contracts Zod schema (rejecting hallucinated
 * args at the boundary) and returns a structured ToolResult. Every check is
 * family-scoped (rule #1): a tool can only read THIS family's rows.
 *
 * Tools whose data source is not yet wired (calendar/vaccine) are deliberately
 * absent from REQUIRED_CHECKS, so they are never on an approval's critical path.
 */

type ToolImpl = (input: unknown, familyId: string) => Promise<ToolResult>;

function pii(content: string, knownChildNames: string[]) {
  const detections: Array<{
    kind: 'child_full_name' | 'child_dob' | 'medical_record' | 'sin' | 'phone' | 'address';
    excerpt: string;
    recommendation: string;
  }> = [];

  const sin = content.match(/\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/);
  if (sin) {
    detections.push({ kind: 'sin', excerpt: sin[0], recommendation: 'redact SIN' });
  }
  const dob = content.match(/\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/);
  if (dob) {
    detections.push({ kind: 'child_dob', excerpt: dob[0], recommendation: 'redact full DOB' });
  }
  const ohip = content.match(/\b\d{4}\s\d{3}\s\d{3}\b/);
  if (ohip) {
    detections.push({
      kind: 'medical_record',
      excerpt: ohip[0],
      recommendation: 'redact health-card / OHIP number',
    });
  }
  const phone = content.match(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone && phone[0] !== ohip?.[0]) {
    detections.push({ kind: 'phone', excerpt: phone[0], recommendation: 'redact phone number' });
  }
  const postal = content.match(/\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/);
  if (postal) {
    detections.push({
      kind: 'address',
      excerpt: postal[0],
      recommendation: 'redact street address / postal code',
    });
  }
  for (const name of knownChildNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(content)) {
      detections.push({
        kind: 'child_full_name',
        excerpt: name,
        recommendation: "redact the child's name",
      });
    }
  }
  return detections;
}

export function buildReviewerTools(database: Database): Record<ReviewerToolName, ToolImpl> {
  async function knownChildNames(familyId: string): Promise<string[]> {
    const rows = await database
      .select({ name: schema.children.name })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId));
    return rows.map((r) => r.name);
  }

  return {
    check_spending_cap: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_spending_cap.input.parse({ ...(raw as object), familyId });
      const caps = DEFAULT_SAFETY_POLICY.spendingCaps;
      if (input.amountUsd > caps.perActionMaxUsd) {
        return {
          tool: 'check_spending_cap',
          ok: false,
          result: {
            withinLimits: false,
            exceededCap: 'per_action',
            limitUsd: caps.perActionMaxUsd,
            rationale: `amount ${input.amountUsd} exceeds per-action cap of ${caps.perActionMaxUsd}`,
          },
        };
      }
      if (caps.categoriesRequiringApproval.includes(input.category)) {
        return {
          tool: 'check_spending_cap',
          ok: false,
          result: {
            withinLimits: false,
            exceededCap: 'category_requires_approval',
            rationale: `category "${input.category}" requires explicit approval`,
          },
        };
      }
      return {
        tool: 'check_spending_cap',
        ok: true,
        result: {
          withinLimits: true,
          rationale: `amount ${input.amountUsd} within per-action cap of ${caps.perActionMaxUsd}`,
        },
      };
    },

    check_action_idempotency: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_action_idempotency.input.parse({
        ...(raw as object),
        familyId,
      });
      const since = new Date(Date.now() - input.lookbackHours * 60 * 60 * 1000);
      const dupes = await database
        .select({ id: schema.actions.id })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.familyId, familyId),
            gte(schema.actions.draftedAt, since),
            sql`${schema.actions.payload} ->> 'action_hash' = ${input.actionHash}`,
          ),
        )
        .limit(1);
      const matched = dupes[0];
      return {
        tool: 'check_action_idempotency',
        ok: !matched,
        result: {
          isDuplicate: !!matched,
          matchedActionId: matched?.id,
          rationale: matched ? 'duplicate action found' : 'no recent duplicate action',
        },
      };
    },

    check_recipient_allowlist: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_recipient_allowlist.input.parse({
        ...(raw as object),
        familyId,
      });
      const facts = await database
        .select({ value: schema.familyMemoryFacts.factValue })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.factType, 'relationship'),
            eq(schema.familyMemoryFacts.factKey, `recipient:${input.recipient}`),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        )
        .limit(1);
      const known = !!facts[0];
      const requiresApproval =
        input.recipientCategory === 'medical' || input.recipientCategory === 'legal';
      return {
        tool: 'check_recipient_allowlist',
        ok: known && !requiresApproval,
        result: {
          allowed: known,
          requiresApproval,
          rationale: known
            ? requiresApproval
              ? 'recipient known but category requires per-action approval'
              : 'recipient on allowlist'
            : 'recipient not yet on allowlist',
        },
      };
    },

    check_sender_allowlist: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_sender_allowlist.input.parse({
        ...(raw as object),
        familyId,
      });
      const facts = await database
        .select({
          value: schema.familyMemoryFacts.factValue,
          validFrom: schema.familyMemoryFacts.validFrom,
        })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.factType, 'relationship'),
            eq(schema.familyMemoryFacts.factKey, `sender:${input.sender}`),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        )
        .limit(1);
      const known = facts[0];
      return {
        tool: 'check_sender_allowlist',
        ok: !!known,
        result: {
          trusted: !!known,
          firstSeenAt: known?.validFrom?.toISOString(),
          rationale: known ? 'sender trusted via prior relationship fact' : 'sender not yet seen',
        },
      };
    },

    check_pii_leak: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_pii_leak.input.parse({ ...(raw as object), familyId });
      const names = input.knownChildNames ?? (await knownChildNames(familyId));
      const detections = pii(input.content, names);
      return {
        tool: 'check_pii_leak',
        ok: detections.length === 0,
        result: {
          leakDetected: detections.length > 0,
          detections,
          namesUnavailable: names.length === 0,
        },
      };
    },

    check_user_override: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_user_override.input.parse({ ...(raw as object), familyId });
      const facts = await database
        .select({ value: schema.familyMemoryFacts.factValue })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.factType, 'preference'),
            eq(schema.familyMemoryFacts.factKey, `action_override:${input.actionType}`),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        )
        .limit(1);
      const override =
        (facts[0]?.value as 'always_ask' | 'autonomous_allowed' | 'never' | undefined) ?? 'none';
      return {
        tool: 'check_user_override',
        ok: override !== 'never',
        result: { override },
      };
    },

    check_action_time_window: async (raw, familyId) => {
      const input = REVIEWER_TOOLS.check_action_time_window.input.parse({
        ...(raw as object),
        familyId,
      });
      const policy = DEFAULT_SAFETY_POLICY;
      const proposed = new Date(input.proposedExecutionAt);
      const hour = Number.parseInt(
        new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          hour12: false,
          timeZone: policy.timeWindow.timezone,
        }).format(proposed),
        10,
      );
      const [openStr, closeStr] = policy.timeWindow.allowActionsBetween;
      const openHour = Number.parseInt(openStr.split(':')[0] ?? '6', 10);
      const closeHour = Number.parseInt(closeStr.split(':')[0] ?? '22', 10);
      const withinWindow = hour >= openHour && hour < closeHour;
      return {
        tool: 'check_action_time_window',
        ok: withinWindow,
        result: {
          withinWindow,
          windowDescription: `${openStr}–${closeStr} ${policy.timeWindow.timezone}`,
          observedHour: hour,
        },
      };
    },

    check_calendar_conflict: async () => ({
      tool: 'check_calendar_conflict',
      ok: false,
      result: { hasConflict: false, conflictingEvents: [], reason: 'not_configured' },
    }),

    check_vaccine_schedule: async () => ({
      tool: 'check_vaccine_schedule',
      ok: false,
      result: { onSchedule: false, rationale: 'not_configured' },
    }),
  };
}
