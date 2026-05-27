import { logger } from '../logger.js';
import type { DraftedAction, ReviewerVerdict, ToolResult } from '@mira/types';
import { invokeReviewerTool } from '../tools/registry.js';

interface ReviewerRunInput {
  familyId: string;
  draft: DraftedAction & { agentRunId: string };
}

/**
 * Reviewer agent — Claude Sonnet 4.6, REQUIRED tool use.
 *
 * Per Section 1.4 of the spec: Reviewer MUST invoke verification tools.
 * Reasoning from prose alone is not sufficient for approval.
 *
 * STUB: deterministically calls the relevant tools based on action type
 * and returns approve/reject/flag based on aggregate tool results. Real
 * version invokes Claude with the tool registry and synthesizes a verdict
 * from the tool outputs.
 */
export async function runReviewer(input: ReviewerRunInput): Promise<ReviewerVerdict> {
  logger.debug(
    { familyId: input.familyId, actionType: input.draft.actionType },
    'reviewer: stub run',
  );

  const toolResults: ToolResult[] = [];

  // Always check time window + idempotency.
  toolResults.push(
    await invokeReviewerTool('check_action_time_window', {
      familyId: input.familyId,
      proposedExecutionAt: new Date().toISOString(),
    }),
  );

  toolResults.push(
    await invokeReviewerTool('check_action_idempotency', {
      familyId: input.familyId,
      actionHash: input.draft.id,
      lookbackHours: 24,
    }),
  );

  // Action-type-specific checks.
  if (
    input.draft.actionType === 'send_email' ||
    input.draft.actionType === 'reply_to_email'
  ) {
    const payload = input.draft.payload as { to: string };
    toolResults.push(
      await invokeReviewerTool('check_recipient_allowlist', {
        familyId: input.familyId,
        recipient: payload.to,
        recipientCategory: 'general',
      }),
    );
  }

  if (input.draft.actionType === 'create_calendar_event') {
    const payload = input.draft.payload as { startsAt: string; durationMinutes: number };
    toolResults.push(
      await invokeReviewerTool('check_calendar_conflict', {
        familyId: input.familyId,
        startsAt: payload.startsAt,
        durationMinutes: payload.durationMinutes,
      }),
    );
  }

  if (input.draft.actionType === 'place_supply_order') {
    const payload = input.draft.payload as { amountUsd: number; category: string };
    toolResults.push(
      await invokeReviewerTool('check_spending_cap', {
        familyId: input.familyId,
        amountUsd: payload.amountUsd,
        category: payload.category,
      }),
    );
  }

  const allOk = toolResults.every((r) => r.ok);

  if (allOk) {
    return {
      kind: 'approve',
      toolResults,
      rationale: 'all verification tools passed',
    };
  }

  const failedCount = toolResults.filter((r) => !r.ok).length;
  if (failedCount === 1) {
    return {
      kind: 'flag_for_human',
      toolResults,
      rationale: 'single verification tool flagged — surfacing for human review',
    };
  }

  return {
    kind: 'reject',
    toolResults,
    rationale: `${failedCount} verification tools failed`,
    remediation: 'modify the draft to address the failed checks and resubmit',
  };
}
