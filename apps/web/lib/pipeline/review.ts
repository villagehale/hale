import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import type { Database } from '@hale/db';
import {
  coverageSatisfiedWithResults,
  firstUnsatisfiedCheck,
  REVIEWER_TOOLS,
  type ReviewerToolName,
} from '@hale/tools-contracts';
import type { DraftedAction, ReviewerVerdict, ToolResult } from '@hale/types';
import { loadReviewActionSkill } from './skill';
import { buildReviewerTools } from './reviewer-tools';

/**
 * Review stage — the structural enforcement of hard rule #3 (the reviewer MUST
 * invoke verification tools; never approve on prose). The web-side mirror of the
 * worker's runReviewer: a hand-rolled tool-use loop (NOT runAgent, which has no
 * verdict-tool terminal nor the coverage downgrade), driven by the review-action
 * SKILL body as system prompt (rule #2) and the model from pickModel (review →
 * Sonnet).
 *
 * The hard rule is code-enforced, not prompt-enforced: an `approve` verdict whose
 * collected tool RESULTS do not satisfy the per-action coverage matrix (every
 * REQUIRED_CHECK invoked AND ok:true — rules #3 + #7) is DOWNGRADED to
 * flag_for_human. A model that jumps straight to approve with zero tool calls can
 * never produce an approve verdict.
 *
 * The Anthropic client is injected so tests drive the loop mechanics with a fake;
 * agent QUALITY is an eval against real cached Claude (rule #8), not asserted here.
 */

const VERDICT_TOOL = 'submit_verdict';
const MAX_TURNS = 8;
const MAX_TOKENS = 4096;

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

export interface ReviewResult {
  verdict: ReviewerVerdict;
  usage: { promptTokens: number; completionTokens: number };
}

export async function reviewAction(
  input: { familyId: string; draft: DraftedAction },
  database: Database,
  client: AgentClient,
): Promise<ReviewResult> {
  const skill = await loadReviewActionSkill();
  const system = skill.instructions;
  const model = pickModel(skill.meta.task);
  const tools = buildReviewerTools(database);

  const collected: ToolResult[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  const finish = (verdict: ReviewerVerdict): ReviewResult => ({
    verdict,
    usage: { promptTokens, completionTokens },
  });

  const allTools: Anthropic.Tool[] = [...checkTools(), verdictTool];
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
      max_tokens: MAX_TOKENS,
      system,
      tools: allTools,
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
          const failed = firstUnsatisfiedCheck(input.draft.actionType, results);
          return finish({
            kind: 'flag_for_human',
            toolResults: collected,
            rationale: `COVERAGE_NOT_SATISFIED: model approved but ${failed} for ${input.draft.actionType} was not invoked or returned ok:false`,
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
      const impl = tools[block.name as ReviewerToolName];
      if (!impl) {
        throw new Error(`reviewAction: model called unknown tool '${block.name}'`);
      }
      // A check that throws (a hallucinated/incomplete tool input failing Zod, a
      // transient DB error) fails CLOSED to a red result, not a crashed pipeline:
      // ok:false counts against the coverage gate, so an approve still cannot pass
      // (rule #3). Mirrors the worker's invokeReviewerTool try/catch.
      let result: ToolResult;
      try {
        result = await impl(block.input, input.familyId);
      } catch (err) {
        result = {
          tool: block.name,
          ok: false,
          result: { error: err instanceof Error ? err.message : 'unknown error' },
        };
      }
      collected.push(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return finish({
    kind: 'flag_for_human',
    toolResults: collected,
    rationale: 'reviewer reached turn cap without producing a verdict',
  });
}
