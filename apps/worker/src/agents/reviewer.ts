import type Anthropic from '@anthropic-ai/sdk';
import {
  REVIEWER_TOOLS,
  coverageSatisfiedWithResults,
  firstUnsatisfiedCheck,
  type ReviewerToolName,
} from '@haru/tools-contracts';
import type { DraftedAction, ReviewerVerdict, ToolResult } from '@haru/types';
import { anthropicClient, SONNET_MODEL } from '../anthropic/client.js';
import { invokeReviewerTool } from '../tools/registry.js';
import { loadChildNames } from '../services/memory-writer.js';
import { metricsFromUsage, type AgentRunMetrics } from './run-metrics.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';

const VERDICT_TOOL = 'submit_verdict';
const MAX_TURNS = 8;

export type ReviewerAnthropicClient = Pick<Anthropic, 'messages'>;

interface ReviewerRunInput {
  familyId: string;
  draft: DraftedAction;
}

export interface ReviewerRunResult {
  verdict: ReviewerVerdict;
  runMetrics: AgentRunMetrics;
}

type InvokeTool = (name: ReviewerToolName, input: unknown) => Promise<ToolResult>;

interface ReviewerDeps {
  client?: ReviewerAnthropicClient;
  invokeTool?: InvokeTool;
  /** Family children's names, injected into check_pii_leak so child_full_name
   * leaks can be matched. Injectable for tests; defaults to the DB lookup. */
  loadChildNames?: (familyId: string) => Promise<string[]>;
}

const verdictTool: Anthropic.Tool = {
  name: VERDICT_TOOL,
  description:
    'Submit your final verdict. Call this ONLY after invoking the verification tools required for this action.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'reject', 'flag_for_human'] },
      rationale: { type: 'string' },
      remediation: { type: 'string' },
    },
    required: ['verdict', 'rationale'],
  },
};

function checkTools(): Anthropic.Tool[] {
  return (Object.keys(REVIEWER_TOOLS) as ReviewerToolName[]).map((name) => ({
    name,
    description: `Verification check: ${name}.`,
    input_schema: { type: 'object', additionalProperties: true },
  }));
}

export async function runReviewer(
  input: ReviewerRunInput,
  deps: ReviewerDeps = {},
): Promise<ReviewerRunResult> {
  const client = deps.client ?? anthropicClient();
  const invokeTool = deps.invokeTool ?? invokeReviewerTool;
  const getChildNames = deps.loadChildNames ?? loadChildNames;
  const system = await loadPrompt('reviewer');
  const collected: ToolResult[] = [];

  // The model cannot know the family's child names; check_pii_leak needs them to
  // detect child_full_name leaks. Fetched once, lazily, only if the model
  // actually invokes the PII check. Empty → the tool reports names_unavailable.
  let childNames: string[] | null = null;

  // Reviewer is a multi-turn loop — one agent_runs row aggregates the whole
  // review, summing usage across every messages.create call it made.
  let promptTokens = 0;
  let completionTokens = 0;
  const startedAt = Date.now();
  const finish = (verdict: ReviewerVerdict): ReviewerRunResult => ({
    verdict,
    runMetrics: metricsFromUsage(
      'reviewer',
      SONNET_MODEL,
      {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
      },
      Date.now() - startedAt,
    ),
  });

  const tools: Anthropic.Tool[] = [...checkTools(), verdictTool];
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

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 4096,
      system,
      tools,
      messages,
    });
    promptTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    completionTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    messages.push({ role: 'assistant', content: response.content });

    const verdictCall = toolUses.find((b) => b.name === VERDICT_TOOL);
    if (verdictCall) {
      const v = verdictCall.input as {
        verdict: 'approve' | 'reject' | 'flag_for_human';
        rationale: string;
        remediation?: string;
      };
      if (v.verdict === 'approve') {
        const results = collected.map((r) => ({ tool: r.tool, ok: r.ok }));
        if (!coverageSatisfiedWithResults(input.draft.actionType, results)) {
          const failedCheck = firstUnsatisfiedCheck(input.draft.actionType, results);
          logger.warn(
            { familyId: input.familyId, actionType: input.draft.actionType, failedCheck, results },
            'reviewer: approve downgraded — required verification coverage not satisfied',
          );
          return finish({
            kind: 'flag_for_human',
            toolResults: collected,
            rationale: `COVERAGE_NOT_SATISFIED: model approved but ${failedCheck} for ${input.draft.actionType} was not invoked or returned ok:false`,
          });
        }
        return finish({ kind: 'approve', toolResults: collected, rationale: v.rationale });
      }
      if (v.verdict === 'reject') {
        return finish({
          kind: 'reject',
          toolResults: collected,
          rationale: v.rationale,
          ...(v.remediation && { remediation: v.remediation }),
        });
      }
      return finish({ kind: 'flag_for_human', toolResults: collected, rationale: v.rationale });
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      let toolInput = block.input;
      if (block.name === 'check_pii_leak') {
        if (childNames === null) childNames = await getChildNames(input.familyId);
        toolInput = { ...(block.input as object), knownChildNames: childNames };
      }
      const result = await invokeTool(block.name as ReviewerToolName, toolInput);
      collected.push(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  logger.warn({ familyId: input.familyId }, 'reviewer: hit turn cap without a verdict');
  return finish({
    kind: 'flag_for_human',
    toolResults: collected,
    rationale: 'reviewer reached turn cap without producing a verdict',
  });
}
