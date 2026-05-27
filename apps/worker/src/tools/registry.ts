import { REVIEWER_TOOLS, type ReviewerToolName } from '@mira/tools-contracts';
import type { ToolResult } from '@mira/types';
import { logger } from '../logger.js';

/**
 * Reviewer tool registry. Each tool validates its input through the
 * Zod schema (rejecting hallucinated args at the boundary) and returns
 * a structured ToolResult that the Reviewer synthesizes.
 *
 * Implementations below are STUBS — they return reasonable defaults.
 * Real implementations query Postgres / external APIs.
 */

type ToolImplementation<TName extends ReviewerToolName> = (
  input: unknown,
) => Promise<{ tool: TName; ok: boolean; result: unknown }>;

const implementations: { [K in ReviewerToolName]: ToolImplementation<K> } = {
  check_action_time_window: async (raw) => {
    const input = REVIEWER_TOOLS.check_action_time_window.input.parse(raw);
    return {
      tool: 'check_action_time_window',
      ok: true,
      result: {
        withinWindow: true,
        windowDescription: '06:00–22:00 America/Toronto',
      },
    };
  },
  check_action_idempotency: async (raw) => {
    const input = REVIEWER_TOOLS.check_action_idempotency.input.parse(raw);
    void input;
    return {
      tool: 'check_action_idempotency',
      ok: true,
      result: { isDuplicate: false, rationale: 'no recent duplicate action found' },
    };
  },
  check_calendar_conflict: async (raw) => {
    const input = REVIEWER_TOOLS.check_calendar_conflict.input.parse(raw);
    void input;
    return {
      tool: 'check_calendar_conflict',
      ok: true,
      result: { hasConflict: false, conflictingEvents: [] },
    };
  },
  check_vaccine_schedule: async (raw) => {
    const input = REVIEWER_TOOLS.check_vaccine_schedule.input.parse(raw);
    void input;
    return {
      tool: 'check_vaccine_schedule',
      ok: true,
      result: { onSchedule: true, rationale: 'stub — assumes on schedule' },
    };
  },
  check_spending_cap: async (raw) => {
    const input = REVIEWER_TOOLS.check_spending_cap.input.parse(raw);
    return {
      tool: 'check_spending_cap',
      ok: input.amountUsd < 50,
      result: {
        withinLimits: input.amountUsd < 50,
        ...(input.amountUsd >= 50 && { exceededCap: 'per_action' as const, limitUsd: 50 }),
        rationale: `amount ${input.amountUsd} vs $50 per-action cap`,
      },
    };
  },
  check_recipient_allowlist: async (raw) => {
    const input = REVIEWER_TOOLS.check_recipient_allowlist.input.parse(raw);
    void input;
    return {
      tool: 'check_recipient_allowlist',
      ok: true,
      result: {
        allowed: true,
        requiresApproval: false,
        rationale: 'stub allowlist — permissive',
      },
    };
  },
  check_sender_allowlist: async (raw) => {
    const input = REVIEWER_TOOLS.check_sender_allowlist.input.parse(raw);
    void input;
    return {
      tool: 'check_sender_allowlist',
      ok: true,
      result: { trusted: true, rationale: 'stub — sender trusted' },
    };
  },
  check_pii_leak: async (raw) => {
    const input = REVIEWER_TOOLS.check_pii_leak.input.parse(raw);
    void input;
    return {
      tool: 'check_pii_leak',
      ok: true,
      result: { leakDetected: false, detections: [] },
    };
  },
  check_user_override: async (raw) => {
    const input = REVIEWER_TOOLS.check_user_override.input.parse(raw);
    void input;
    return {
      tool: 'check_user_override',
      ok: true,
      result: { override: 'none' as const },
    };
  },
};

export async function invokeReviewerTool<TName extends ReviewerToolName>(
  name: TName,
  input: unknown,
): Promise<ToolResult> {
  try {
    const impl = implementations[name];
    const result = await impl(input);
    return result as ToolResult;
  } catch (err) {
    logger.warn({ tool: name, err }, 'tool invocation failed');
    return {
      tool: name,
      ok: false,
      result: { error: err instanceof Error ? err.message : 'unknown error' },
    };
  }
}
