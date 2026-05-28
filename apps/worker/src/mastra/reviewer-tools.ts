import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ReviewerToolName } from '@haru/tools-contracts';
import type { ToolResult } from '@haru/types';
import { invokeReviewerTool } from '../tools/registry.js';

/**
 * Bridges our existing `tools/registry.ts` implementations into Mastra
 * tool definitions. Mastra calls the `execute()` function when Claude
 * requests the tool; the registry handles the real DB query / API call
 * and returns a typed result, which Mastra feeds back into the
 * conversation as a tool result.
 *
 * Schemas come straight from @haru/tools-contracts — same Zod schemas
 * the registry uses, so input validation happens once at the boundary.
 *
 * Side effect: each `execute` records the ToolResult into the run-scoped
 * collector so the Reviewer agent can return it alongside its verdict.
 */

export interface ReviewerToolContext {
  collected: ToolResult[];
}

function makeTool<TName extends ReviewerToolName>(
  name: TName,
  description: string,
  collected: ToolResult[],
) {
  // Permissive runtime schemas at this boundary — input/output validation
  // already happens inside invokeReviewerTool via the @haru/tools-contracts
  // Zod schemas (REVIEWER_TOOLS[name].input.parse). Using z.unknown() here
  // sidesteps Mastra's tighter compile-time inference (which trips on our
  // discriminated tool registry typing).
  return createTool({
    id: name,
    description,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: async (input: unknown) => {
      const result = await invokeReviewerTool(name, input);
      collected.push(result);
      return result.result;
    },
  });
}

export function buildReviewerTools(collected: ToolResult[]) {
  return {
    check_action_time_window: makeTool(
      'check_action_time_window',
      'Verifies the proposed execution time falls within the family-configured action window.',
      collected,
    ),
    check_action_idempotency: makeTool(
      'check_action_idempotency',
      'Checks whether an action with the same hash has been recorded recently.',
      collected,
    ),
    check_spending_cap: makeTool(
      'check_spending_cap',
      "Verifies the action's monetary cost is within the family's spending caps.",
      collected,
    ),
    check_recipient_allowlist: makeTool(
      'check_recipient_allowlist',
      'Verifies the action recipient has been approved by the family.',
      collected,
    ),
    check_sender_allowlist: makeTool(
      'check_sender_allowlist',
      'Verifies an inbound sender is trusted via prior interaction.',
      collected,
    ),
    check_calendar_conflict: makeTool(
      'check_calendar_conflict',
      'Checks for calendar conflicts at the proposed time.',
      collected,
    ),
    check_vaccine_schedule: makeTool(
      'check_vaccine_schedule',
      'Checks proposed vaccine date against Health Canada / CDC schedule.',
      collected,
    ),
    check_pii_leak: makeTool(
      'check_pii_leak',
      'Detects PII (SIN, DOB, address) in outgoing content not destined for an allowed recipient.',
      collected,
    ),
    check_user_override: makeTool(
      'check_user_override',
      'Checks whether the family has an explicit override for this action type.',
      collected,
    ),
  };
}
