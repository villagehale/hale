import { and, eq, gt, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { REVIEWER_TOOLS, type ReviewerToolName } from '@hale/tools-contracts';
import type { ToolResult } from '@hale/types';
import { db } from '../db.js';
import { logger } from '../logger.js';

/**
 * Reviewer tool registry.
 *
 * Each tool validates its input via Zod (rejecting hallucinated args at
 * the boundary) and returns a structured ToolResult.
 *
 * Implementations are REAL where the data source is internal (Postgres,
 * derived rules). Tools that need external API calls or schedules we
 * don't yet have a source for return `ok: false` with a clear
 * `not_configured` reason — the Reviewer treats them as red and
 * flag-for-human is the route.
 */

// The default database is the worker's db(); the web pipeline injects its own
// request-scoped database.
type ToolImpl<TName extends ReviewerToolName> = (
  input: unknown,
  database: Database,
) => Promise<{ tool: TName; ok: boolean; result: unknown }>;

const implementations: { [K in ReviewerToolName]: ToolImpl<K> } = {
  // ───────────────────────────────────────────────────────────────────
  // Time window — uses the family's stored timezone + safety policy.
  // ───────────────────────────────────────────────────────────────────
  check_action_time_window: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_action_time_window.input.parse(raw);
    const family = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.families)
      .leftJoin(schema.familyMembers, eq(schema.familyMembers.familyId, schema.families.id))
      .leftJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
      .where(eq(schema.families.id, input.familyId))
      .limit(1);

    const timezone = family[0]?.timezone;
    if (!timezone) {
      return {
        tool: 'check_action_time_window',
        ok: false,
        result: {
          withinWindow: false,
          windowDescription: 'not_configured: family timezone not yet set',
        },
      };
    }

    const proposed = new Date(input.proposedExecutionAt);
    const hourString = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(proposed);
    const hour = Number.parseInt(hourString, 10);
    const policy = await loadFamilySafetyPolicy(input.familyId);
    const [openStr, closeStr] = policy.timeWindow.allowActionsBetween;
    const openParts = openStr?.split(':');
    const closeParts = closeStr?.split(':');
    if (!openParts || !closeParts) {
      return {
        tool: 'check_action_time_window',
        ok: false,
        result: {
          withinWindow: false,
          windowDescription: `malformed time window in policy: ${openStr}-${closeStr}`,
        },
      };
    }
    const openHour = Number.parseInt(openParts[0] ?? '6', 10);
    const closeHour = Number.parseInt(closeParts[0] ?? '22', 10);
    const withinWindow = hour >= openHour && hour < closeHour;

    return {
      tool: 'check_action_time_window',
      ok: withinWindow,
      result: {
        withinWindow,
        windowDescription: `${openStr}–${closeStr} ${timezone}`,
        observedHour: hour,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Idempotency — has an action with the same hash been recorded for
  // this family in the lookback window?
  // ───────────────────────────────────────────────────────────────────
  check_action_idempotency: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_action_idempotency.input.parse(raw);
    const since = new Date(Date.now() - input.lookbackHours * 60 * 60 * 1000);
    const duplicates = await database
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.familyId, input.familyId),
          // Exclude the action under review (self-match, ISSUE-5b) when its id is
          // known — the worker reviewer always injects it; the legacy web path omits it.
          ...(input.actionId ? [ne(schema.actions.id, input.actionId)] : []),
          gte(schema.actions.draftedAt, since),
          sql`${schema.actions.payload} ->> 'action_hash' = ${input.actionHash}`,
        ),
      )
      .limit(1);

    const matched = duplicates[0];
    return {
      tool: 'check_action_idempotency',
      ok: !matched,
      result: {
        isDuplicate: !!matched,
        matchedActionId: matched?.id,
        rationale: matched
          ? `duplicate action found within ${input.lookbackHours}h`
          : 'no recent duplicate action found',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Spending cap — checks against the family's safety_policy field
  // (stored as JSON on the families row in production; for now the
  // policy is fetched per-call from a sane default in @hale/types).
  // ───────────────────────────────────────────────────────────────────
  check_spending_cap: async (raw) => {
    const input = REVIEWER_TOOLS.check_spending_cap.input.parse(raw);
    const policy = await loadFamilySafetyPolicy(input.familyId);

    if (input.amountUsd > policy.spendingCaps.perActionMaxUsd) {
      return {
        tool: 'check_spending_cap',
        ok: false,
        result: {
          withinLimits: false,
          exceededCap: 'per_action' as const,
          limitUsd: policy.spendingCaps.perActionMaxUsd,
          rationale: `amount ${input.amountUsd} exceeds per-action cap of ${policy.spendingCaps.perActionMaxUsd}`,
        },
      };
    }

    if (policy.spendingCaps.categoriesRequiringApproval.includes(input.category)) {
      return {
        tool: 'check_spending_cap',
        ok: false,
        result: {
          withinLimits: false,
          exceededCap: 'category_requires_approval' as const,
          rationale: `category "${input.category}" requires explicit approval per family policy`,
        },
      };
    }

    return {
      tool: 'check_spending_cap',
      ok: true,
      result: {
        withinLimits: true,
        rationale: `amount ${input.amountUsd} within per-action cap of ${policy.spendingCaps.perActionMaxUsd}`,
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Calendar conflict (VIL-219) — does the proposed placement's window
  // [startsAt, startsAt+durationMinutes) overlap any LIVE family_events row?
  // Queries Hale's own placements/occasions (soft-deleted rows excluded);
  // ok:true means the slot is clear. Half-open interval semantics: a timed
  // event conflicts iff it truly overlaps (back-to-back does not); a point
  // event (no end) conflicts iff its instant falls inside the window.
  // ───────────────────────────────────────────────────────────────────
  check_calendar_conflict: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_calendar_conflict.input.parse(raw);
    const newStart = new Date(input.startsAt);
    const newEnd = new Date(newStart.getTime() + input.durationMinutes * 60 * 1000);

    const overlapping = await database
      .select({
        id: schema.familyEvents.id,
        title: schema.familyEvents.title,
        startsAt: schema.familyEvents.startsAt,
        endsAt: schema.familyEvents.endsAt,
      })
      .from(schema.familyEvents)
      .where(
        and(
          eq(schema.familyEvents.familyId, input.familyId),
          isNull(schema.familyEvents.deletedAt),
          lt(schema.familyEvents.startsAt, newEnd),
          or(
            and(
              sql`${schema.familyEvents.endsAt} IS NOT NULL`,
              gt(schema.familyEvents.endsAt, newStart),
            ),
            and(
              isNull(schema.familyEvents.endsAt),
              gte(schema.familyEvents.startsAt, newStart),
            ),
          ),
        ),
      )
      .limit(20);

    return {
      tool: 'check_calendar_conflict',
      ok: overlapping.length === 0,
      result: {
        hasConflict: overlapping.length > 0,
        conflictingEvents: overlapping.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: (e.endsAt ?? e.startsAt).toISOString(),
        })),
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Vaccine schedule — needs Health Canada / CDC schedule data loaded.
  // Returns not_configured until the data + child birth date lookup
  // are wired.
  // ───────────────────────────────────────────────────────────────────
  check_vaccine_schedule: async (raw) => {
    const input = REVIEWER_TOOLS.check_vaccine_schedule.input.parse(raw);
    void input;
    return {
      tool: 'check_vaccine_schedule',
      ok: false,
      result: {
        onSchedule: false,
        rationale: 'not_configured: vaccine schedule data not yet loaded',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Recipient allowlist — checks the family_memory_facts entries with
  // fact_type=relationship for "recipient:<email>" facts.
  // ───────────────────────────────────────────────────────────────────
  check_recipient_allowlist: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_recipient_allowlist.input.parse(raw);
    const facts = await database
      .select({ value: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          eq(schema.familyMemoryFacts.factType, 'relationship'),
          eq(schema.familyMemoryFacts.factKey, `recipient:${input.recipient}`),
          sql`${schema.familyMemoryFacts.validUntil} IS NULL`,
        ),
      )
      .limit(1);

    const known = facts[0];
    const requiresApproval =
      input.recipientCategory === 'medical' || input.recipientCategory === 'legal';

    return {
      tool: 'check_recipient_allowlist',
      ok: !!known && !requiresApproval,
      result: {
        allowed: !!known,
        requiresApproval,
        rationale: known
          ? requiresApproval
            ? 'recipient known but category requires per-action approval'
            : 'recipient on allowlist'
          : 'recipient not yet on allowlist',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // Sender allowlist — analogous, fact_key = "sender:<email>".
  // ───────────────────────────────────────────────────────────────────
  check_sender_allowlist: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_sender_allowlist.input.parse(raw);
    const facts = await database
      .select({
        value: schema.familyMemoryFacts.factValue,
        validFrom: schema.familyMemoryFacts.validFrom,
      })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          eq(schema.familyMemoryFacts.factType, 'relationship'),
          eq(schema.familyMemoryFacts.factKey, `sender:${input.sender}`),
          sql`${schema.familyMemoryFacts.validUntil} IS NULL`,
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
        rationale: known
          ? 'sender trusted via prior relationship fact'
          : 'sender not yet seen — Reviewer should flag for human',
      },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // PII leak — conservative regex/heuristic pass over all six declared
  // kinds (SIN, DOB, phone, address, medical_record, child_full_name)
  // for content leaving the family to a recipient. A production system
  // would layer an ML detector on top; these patterns are the structural
  // floor so rule #1 does not lean on under-detection.
  // ───────────────────────────────────────────────────────────────────
  check_pii_leak: async (raw) => {
    const input = REVIEWER_TOOLS.check_pii_leak.input.parse(raw);
    const detections: Array<{
      kind: 'child_full_name' | 'child_dob' | 'medical_record' | 'sin' | 'phone' | 'address';
      excerpt: string;
      recommendation: string;
    }> = [];
    const content = input.content;

    // SIN: 9 digits, often with separators.
    const sinMatch = content.match(/\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/);
    if (sinMatch) {
      detections.push({
        kind: 'sin',
        excerpt: sinMatch[0],
        recommendation: 'redact SIN from outgoing communication',
      });
    }

    // Long-form DOB: "2025-01-15" or "2025/1/5".
    const dobMatch = content.match(/\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/);
    if (dobMatch) {
      detections.push({
        kind: 'child_dob',
        excerpt: dobMatch[0],
        recommendation: 'consider redacting full DOB; an age in months is usually enough',
      });
    }

    // OHIP/health-card "#### ### ###" — matched before the generic phone
    // pattern so a health-card group is not mislabelled as a phone number.
    const ohipMatch = content.match(/\b\d{4}\s\d{3}\s\d{3}\b/);
    const mrnMatch = content.match(/\b(?:MRN|HCN|health\s*card|chart)\s*#?:?\s*([A-Z]?\d{6,10})\b/i);
    if (ohipMatch) {
      detections.push({
        kind: 'medical_record',
        excerpt: ohipMatch[0],
        recommendation: 'redact health-card / OHIP number from outgoing communication',
      });
    } else if (mrnMatch) {
      detections.push({
        kind: 'medical_record',
        excerpt: mrnMatch[0],
        recommendation: 'redact the medical record / health-card number',
      });
    }

    // Phone: NANP formats — "416-555-0182", "(604) 555 0199", "604.555.0199".
    // Skip any span already claimed as a health-card group above.
    const phoneMatch = content.match(
      /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    );
    if (phoneMatch && phoneMatch[0] !== ohipMatch?.[0]) {
      detections.push({
        kind: 'phone',
        excerpt: phoneMatch[0],
        recommendation: 'redact phone number from outgoing communication',
      });
    }

    // Address: a CA postal code (A1A 1A1) or a street-number + street-word
    // pattern ("123 Maple Street").
    const postalMatch = content.match(/\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/);
    const streetMatch = content.match(
      /\b\d{1,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Lane|Ln|Cres(?:cent)?|Way|Court|Ct|Place|Pl)\b/i,
    );
    if (postalMatch || streetMatch) {
      const m = postalMatch ?? streetMatch;
      detections.push({
        kind: 'address',
        excerpt: m?.[0] ?? '',
        recommendation: 'redact street address / postal code from outgoing communication',
      });
    }

    // child_full_name: whole-word, case-insensitive match against the family's
    // known child names. Degraded (not silent) when names were not supplied.
    const knownChildNames = input.knownChildNames ?? [];
    const namesUnavailable = knownChildNames.length === 0;
    for (const name of knownChildNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(content)) {
        detections.push({
          kind: 'child_full_name',
          excerpt: name,
          recommendation: "redact the child's name from outgoing communication",
        });
      }
    }

    return {
      tool: 'check_pii_leak',
      ok: detections.length === 0,
      result: { leakDetected: detections.length > 0, detections, namesUnavailable },
    };
  },

  // ───────────────────────────────────────────────────────────────────
  // User override — checks family_memory_facts with fact_type=preference
  // and fact_key = "action_override:<actionType>".
  // ───────────────────────────────────────────────────────────────────
  check_user_override: async (raw, database) => {
    const input = REVIEWER_TOOLS.check_user_override.input.parse(raw);
    const facts = await database
      .select({ value: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, input.familyId),
          eq(schema.familyMemoryFacts.factType, 'preference'),
          eq(schema.familyMemoryFacts.factKey, `action_override:${input.actionType}`),
          sql`${schema.familyMemoryFacts.validUntil} IS NULL`,
        ),
      )
      .limit(1);

    const fact = facts[0];
    const override =
      (fact?.value as 'always_ask' | 'autonomous_allowed' | 'never' | undefined) ?? 'none';
    return {
      tool: 'check_user_override',
      ok: override !== 'never',
      result: { override },
    };
  },
};

export async function invokeReviewerTool<TName extends ReviewerToolName>(
  name: TName,
  input: unknown,
  database: Database = db(),
): Promise<ToolResult> {
  try {
    const impl = implementations[name];
    const result = await impl(input, database);
    return result as ToolResult;
  } catch (err) {
    logger.warn({ tool: name, err }, 'reviewer tool invocation failed');
    return {
      tool: name,
      ok: false,
      result: {
        error: err instanceof Error ? err.message : 'unknown error',
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Family safety policy loader.
//
// Production version reads `families.safety_policy` JSONB. For now we return
// the DEFAULT_SAFETY_POLICY from @hale/types so the verification path is
// fully wired even before families have customized their policy.
// ─────────────────────────────────────────────────────────────────────────────

async function loadFamilySafetyPolicy(familyId: string) {
  const { DEFAULT_SAFETY_POLICY } = await import('@hale/types');
  void familyId;
  return DEFAULT_SAFETY_POLICY;
}
