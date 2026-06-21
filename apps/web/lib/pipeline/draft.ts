import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import type { ActionType, DraftedAction } from '@hale/types';
import { z } from 'zod';
import { loadDraftActionSkill } from './skill';
import { forceToolJson } from './structured';

/**
 * Draft stage — a classified event + routed action type → a parent-facing draft,
 * on the @hale/agent harness model routing (draft → Sonnet via pickModel). The
 * prompt is the draft-action SKILL body (rule #2). Single LLM turn via forced-tool
 * JSON; the result is Zod-validated at the boundary.
 */

const MAX_TOKENS = 1536;

const draftOutputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  recipient_visibility: z.enum(['public', 'internal_only']),
});

const draftOutputJsonSchema = {
  type: 'object',
  properties: {
    payload: { type: 'object', additionalProperties: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    recipient_visibility: { type: 'string', enum: ['public', 'internal_only'] },
  },
  required: ['payload', 'confidence', 'rationale', 'recipient_visibility'],
} as const;

export interface DraftInput {
  familyId: string;
  event: { eventId: string; eventType: string; payload: Record<string, unknown> };
  actionType: ActionType;
  memorySlice?: { relevantFacts: unknown[]; relevantEpisodes: unknown[] };
}

export interface DraftResult {
  draft: DraftedAction;
  usage: { promptTokens: number; completionTokens: number };
}

export async function draftAction(input: DraftInput, client: AgentClient): Promise<DraftResult> {
  const skill = await loadDraftActionSkill();
  const userMessage = JSON.stringify({
    action_type: input.actionType,
    event: input.event,
    memory_slice: input.memorySlice ?? null,
  });

  const { value, usage } = await forceToolJson({
    client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage,
    toolName: 'draft_action',
    toolDescription: 'Return the structured draft of the proposed action.',
    inputJsonSchema: draftOutputJsonSchema,
    schema: draftOutputSchema,
    maxTokens: MAX_TOKENS,
  });

  return {
    draft: {
      id: crypto.randomUUID(),
      eventId: input.event.eventId,
      familyId: input.familyId,
      actionType: input.actionType,
      payload: value.payload,
      draftConfidence: value.confidence,
      rationale: value.rationale,
      recipientVisibility: value.recipient_visibility,
      draftedAt: new Date().toISOString(),
    },
    usage: {
      promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
    },
  };
}
