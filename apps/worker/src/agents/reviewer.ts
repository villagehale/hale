import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { DraftedAction, ReviewerVerdict, ToolResult } from '@mira/types';
import { sonnetModel } from '../mastra/model.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';
import { buildReviewerTools } from '../mastra/reviewer-tools.js';

const reviewerOutputSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'flag_for_human']),
  rationale: z.string(),
  if_rejected_remediation_suggestion: z.string().optional(),
});

interface ReviewerRunInput {
  familyId: string;
  draft: DraftedAction & { agentRunId: string };
}

/**
 * Reviewer agent — Mastra-managed tool-use loop.
 *
 * What Mastra owns now (was hand-rolled before):
 *   • multi-turn conversation between Claude and the verification tools
 *   • parallel tool dispatch when Claude requests multiple in one turn
 *   • turn/iteration limits + abort signals
 *   • final structured-output assembly
 *
 * What still lives in our code:
 *   • the tool implementations themselves (tools/registry.ts) —
 *     the actual DB queries / regex / policy checks
 *   • the run-scoped collector so the orchestrator gets a typed
 *     ToolResult[] alongside the verdict for the audit log
 *   • the system prompt (apps/worker/prompts/reviewer.md) which
 *     instructs Claude that tool use is REQUIRED before any verdict
 */
export async function runReviewer(input: ReviewerRunInput): Promise<ReviewerVerdict> {
  const instructions = await loadPrompt('reviewer');
  const collected: ToolResult[] = [];
  const tools = buildReviewerTools(collected);

  const agent = new Agent({
    id: 'mira-reviewer',
    name: 'mira-reviewer',
    instructions,
    model: sonnetModel(),
    tools,
  });

  const userMessage = JSON.stringify({
    draft_action: {
      id: input.draft.id,
      action_type: input.draft.actionType,
      payload: input.draft.payload,
      recipient_visibility: input.draft.recipientVisibility,
      family_id: input.familyId,
    },
  });

  try {
    const result = await agent.generate(userMessage, {
      structuredOutput: { schema: reviewerOutputSchema },
      maxSteps: 8,
    });

    const parsed = result.object;
    if (!parsed) {
      logger.warn(
        { familyId: input.familyId },
        'reviewer: no structured verdict — defaulting to flag',
      );
      return {
        kind: 'flag_for_human',
        toolResults: collected,
        rationale: 'reviewer produced no parseable verdict',
      };
    }

    if (parsed.verdict === 'approve') {
      return { kind: 'approve', toolResults: collected, rationale: parsed.rationale };
    }
    if (parsed.verdict === 'reject') {
      return {
        kind: 'reject',
        toolResults: collected,
        rationale: parsed.rationale,
        ...(parsed.if_rejected_remediation_suggestion && {
          remediation: parsed.if_rejected_remediation_suggestion,
        }),
      };
    }
    return {
      kind: 'flag_for_human',
      toolResults: collected,
      rationale: parsed.rationale,
    };
  } catch (err) {
    logger.error({ familyId: input.familyId, err }, 'reviewer: generate threw');
    return {
      kind: 'flag_for_human',
      toolResults: collected,
      rationale: err instanceof Error ? err.message : 'reviewer loop failed',
    };
  }
}
