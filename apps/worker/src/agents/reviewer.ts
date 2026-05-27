import type Anthropic from '@anthropic-ai/sdk';
import { anthropic } from '../anthropic.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';
import type { DraftedAction, ReviewerVerdict, ToolResult } from '@mira/types';
import { invokeReviewerTool } from '../tools/registry.js';
import type { ReviewerToolName } from '@mira/tools-contracts';

const REVIEWER_MODEL = 'claude-sonnet-4-6';

interface ReviewerRunInput {
  familyId: string;
  draft: DraftedAction & { agentRunId: string };
}

/**
 * Reviewer runs a tool-using loop:
 *   1. Pass the draft to Claude with the reviewer system prompt + tool defs.
 *   2. When Claude requests tool calls, dispatch them through invokeReviewerTool.
 *   3. Loop until Claude returns a final verdict.
 *
 * Required tools per spec §3.4: time window, idempotency, recipient/sender
 * allowlist (where applicable), spending cap (where applicable), PII leak.
 */
export async function runReviewer(input: ReviewerRunInput): Promise<ReviewerVerdict> {
  const systemPrompt = await loadPrompt('reviewer');

  const tools = REVIEWER_TOOL_DEFS;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: JSON.stringify({
        draft_action: {
          id: input.draft.id,
          action_type: input.draft.actionType,
          payload: input.draft.payload,
          recipient_visibility: input.draft.recipientVisibility,
          family_id: input.familyId,
        },
      }),
    },
  ];

  const toolResults: ToolResult[] = [];
  const MAX_ITERATIONS = 8;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic().messages.create({
      model: REVIEWER_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return parseVerdict(text, toolResults);
    }

    if (response.stop_reason !== 'tool_use') {
      logger.warn({ stopReason: response.stop_reason }, 'reviewer: unexpected stop reason');
      return { kind: 'flag_for_human', toolResults, rationale: 'reviewer loop ended unexpectedly' };
    }

    // Dispatch all requested tool calls in this turn.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolResultsThisTurn: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (!isKnownTool(block.name)) {
        toolResultsThisTurn.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: `unknown tool: ${block.name}` }),
          is_error: true,
        });
        continue;
      }
      const result = await invokeReviewerTool(block.name, block.input);
      toolResults.push(result);
      toolResultsThisTurn.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.result),
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultsThisTurn });
  }

  logger.warn({ familyId: input.familyId }, 'reviewer: max iterations reached');
  return {
    kind: 'flag_for_human',
    toolResults,
    rationale: 'reviewer exceeded max iterations without producing a verdict',
  };
}

function parseVerdict(text: string, toolResults: ToolResult[]): ReviewerVerdict {
  const trimmed = text.trim();
  let parsed: { verdict?: string; rationale?: string; if_rejected_remediation_suggestion?: string };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return {
        kind: 'flag_for_human',
        toolResults,
        rationale: 'reviewer produced no parseable verdict',
      };
    }
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as typeof parsed;
  }

  const verdict = parsed.verdict;
  const rationale = parsed.rationale ?? '';
  if (verdict === 'approve') {
    return { kind: 'approve', toolResults, rationale };
  }
  if (verdict === 'reject') {
    return {
      kind: 'reject',
      toolResults,
      rationale,
      ...(parsed.if_rejected_remediation_suggestion && {
        remediation: parsed.if_rejected_remediation_suggestion,
      }),
    };
  }
  return { kind: 'flag_for_human', toolResults, rationale };
}

const KNOWN_TOOLS: readonly ReviewerToolName[] = [
  'check_calendar_conflict',
  'check_vaccine_schedule',
  'check_spending_cap',
  'check_recipient_allowlist',
  'check_sender_allowlist',
  'check_action_time_window',
  'check_action_idempotency',
  'check_pii_leak',
  'check_user_override',
];

function isKnownTool(name: string): name is ReviewerToolName {
  return (KNOWN_TOOLS as readonly string[]).includes(name);
}

// Tool definitions surfaced to Claude. Schemas mirror @mira/tools-contracts.
const REVIEWER_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'check_action_time_window',
    description:
      'Verifies the proposed execution time falls within the family-configured action window.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        proposedExecutionAt: { type: 'string', description: 'ISO 8601 datetime' },
      },
      required: ['familyId', 'proposedExecutionAt'],
    },
  },
  {
    name: 'check_action_idempotency',
    description: 'Checks whether an action with the same hash has been recorded recently.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        actionHash: { type: 'string' },
        lookbackHours: { type: 'number' },
      },
      required: ['familyId', 'actionHash', 'lookbackHours'],
    },
  },
  {
    name: 'check_spending_cap',
    description: "Verifies the action's monetary cost is within the family's spending caps.",
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        amountUsd: { type: 'number' },
        category: { type: 'string' },
      },
      required: ['familyId', 'amountUsd', 'category'],
    },
  },
  {
    name: 'check_recipient_allowlist',
    description: 'Verifies the action recipient has been approved by the family.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        recipient: { type: 'string' },
        recipientCategory: {
          type: 'string',
          enum: ['general', 'medical', 'legal', 'financial', 'unknown'],
        },
      },
      required: ['familyId', 'recipient', 'recipientCategory'],
    },
  },
  {
    name: 'check_sender_allowlist',
    description: 'Verifies an inbound sender is trusted via prior interaction.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        sender: { type: 'string' },
      },
      required: ['familyId', 'sender'],
    },
  },
  {
    name: 'check_calendar_conflict',
    description: 'Checks for calendar conflicts at the proposed time.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        startsAt: { type: 'string' },
        durationMinutes: { type: 'number' },
      },
      required: ['familyId', 'startsAt', 'durationMinutes'],
    },
  },
  {
    name: 'check_vaccine_schedule',
    description: 'Checks proposed vaccine date against Health Canada / CDC schedule.',
    input_schema: {
      type: 'object',
      properties: {
        childId: { type: 'string' },
        vaccineType: { type: 'string' },
        proposedDate: { type: 'string' },
      },
      required: ['childId', 'vaccineType', 'proposedDate'],
    },
  },
  {
    name: 'check_pii_leak',
    description: 'Detects PII (SIN, DOB, address) in outgoing content not destined for an allowed recipient.',
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        content: { type: 'string' },
        allowedRecipients: { type: 'array', items: { type: 'string' } },
      },
      required: ['familyId', 'content', 'allowedRecipients'],
    },
  },
  {
    name: 'check_user_override',
    description: "Checks whether the family has an explicit override for this action type.",
    input_schema: {
      type: 'object',
      properties: {
        familyId: { type: 'string' },
        actionType: { type: 'string' },
      },
      required: ['familyId', 'actionType'],
    },
  },
];
