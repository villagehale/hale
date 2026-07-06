import type Anthropic from '@anthropic-ai/sdk';
import { pickModel } from '@hale/agent';
import {
  REQUIRED_CHECKS,
  type ReviewerToolName,
  coverageSatisfiedWithResults,
  firstUnsatisfiedCheck,
} from '@hale/tools-contracts';
import type { ActionType, DraftedAction, ReviewerVerdict, ToolResult } from '@hale/types';
import { anthropicClient } from '../anthropic/client.js';
import { logger } from '../logger.js';
import { loadPrompt } from '../prompts/loader.js';
import { loadChildNames } from '../services/memory-writer.js';
import { invokeReviewerTool } from '../tools/registry.js';
import { type AgentRunMetrics, metricsFromUsage } from './run-metrics.js';
import { cachedSystem } from './structured.js';

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

// Per-check input contracts the model must see to call a check correctly. The
// generic `additionalProperties:true` schema left the model guessing the field
// names (it sent `{}` / `{action_hash}`), so a required check failed validation
// (ok:false) and the coverage AND-fold poisoned it → every add_to_routine was
// flagged (ISSUE-5). check_action_idempotency is add_to_routine's only required
// check, so its contract must be explicit. Others keep the permissive schema.
const CHECK_INPUT_SCHEMAS: Partial<Record<ReviewerToolName, Anthropic.Tool['input_schema']>> = {
  check_action_idempotency: {
    type: 'object',
    properties: {
      familyId: { type: 'string', description: "The draft action's family_id (a uuid)." },
      actionHash: {
        type: 'string',
        description: "The draft payload's action_hash — pass it verbatim; do not invent one.",
      },
      lookbackHours: { type: 'number', description: 'Optional dedup window; defaults to 24.' },
    },
    required: ['familyId', 'actionHash'],
    additionalProperties: false,
  },
};

// Expose ONLY the checks REQUIRED for this action type. add_to_routine (an
// internal pin) requires just check_action_idempotency; showing it the full
// external-action check set (calendar/pii/time-window) made the model call
// irrelevant checks, fail their required fields, and flag on the noise (ISSUE-5b).
// Scoping to REQUIRED_CHECKS is strictly MORE constrained — the coverage gate
// still enforces every required check returned ok:true.
function checkTools(actionType: ActionType): Anthropic.Tool[] {
  return REQUIRED_CHECKS[actionType].map((name) => ({
    name,
    description: `Verification check: ${name}.`,
    input_schema: CHECK_INPUT_SCHEMAS[name] ?? { type: 'object', additionalProperties: true },
  }));
}

export async function runReviewer(
  input: ReviewerRunInput,
  deps: ReviewerDeps = {},
): Promise<ReviewerRunResult> {
  const client = deps.client ?? anthropicClient();
  const invokeTool = deps.invokeTool ?? invokeReviewerTool;
  const getChildNames = deps.loadChildNames ?? loadChildNames;
  // The reviewer's instructions + tool list are the same on every turn of the
  // loop; caching the system block once lets each turn read the stable
  // tools+system prefix instead of reprocessing it.
  const system = cachedSystem(await loadPrompt('reviewer'));
  const model = pickModel('review');
  const collected: ToolResult[] = [];

  // The model cannot know the family's child names; check_pii_leak needs them to
  // detect child_full_name leaks. Fetched once, lazily, only if the model
  // actually invokes the PII check. Empty → the tool reports names_unavailable.
  let childNames: string[] | null = null;

  // Reviewer is a multi-turn loop — one agent_runs row aggregates the whole
  // review, summing usage across every messages.create call it made. Cache-read
  // tokens are tracked apart from full-rate prompt tokens because they bill at
  // the 0.1x read rate (estimateCostUsd applies the split).
  let promptTokens = 0;
  let cacheReadTokens = 0;
  let completionTokens = 0;
  const startedAt = Date.now();
  const finish = (verdict: ReviewerVerdict): ReviewerRunResult => ({
    verdict,
    runMetrics: metricsFromUsage(
      'reviewer',
      model,
      {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: cacheReadTokens,
        server_tool_use: null,
      },
      Date.now() - startedAt,
    ),
  });

  const tools: Anthropic.Tool[] = [...checkTools(input.draft.actionType), verdictTool];
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
      model,
      max_tokens: 4096,
      system,
      tools,
      messages,
    });
    promptTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
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
      if (block.name === 'check_action_idempotency') {
        // The idempotency key is the draft's OWN stamped action_hash, and the
        // check must exclude the action under review: recordAction persists the
        // draft BEFORE review, so a naive hash match finds the draft matching
        // ITSELF (isDuplicate → ok:false → reject). Inject both server-side —
        // the model cannot be trusted to echo the hash or know its own id, and a
        // fabricated hash would defeat dedup (ISSUE-5b, rule #3 verify-by-fact).
        const payloadHash = (input.draft.payload as { action_hash?: unknown }).action_hash;
        toolInput = {
          ...(block.input as object),
          familyId: input.familyId,
          actionId: input.draft.id,
          actionHash: typeof payloadHash === 'string' ? payloadHash : '',
        };
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
