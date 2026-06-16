import { z } from 'zod';
import type { ActionType, DraftedAction } from '@hale/types';
import { anthropicClient, SONNET_MODEL } from '../anthropic/client.js';
import { forceToolJson } from './structured.js';
import { metricsFromUsage, type AgentRunMetrics } from './run-metrics.js';
import { loadPrompt } from '../prompts/loader.js';

const drafterOutputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  recipient_visibility: z.enum(['public', 'internal_only']),
});

const drafterOutputJsonSchema = {
  type: 'object',
  properties: {
    payload: { type: 'object', additionalProperties: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    recipient_visibility: { type: 'string', enum: ['public', 'internal_only'] },
  },
  required: ['payload', 'confidence', 'rationale', 'recipient_visibility'],
} as const;

interface DrafterRunInput {
  familyId: string;
  event: {
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  };
  actionType: ActionType;
  memorySlice?: {
    relevantFacts: unknown[];
    relevantEpisodes: unknown[];
  };
  voiceProfile?: unknown;
  actionTemplateHint?: string;
}

interface DrafterRunOutput {
  draft: DraftedAction;
  runMetrics: AgentRunMetrics;
}

export async function runDrafter(input: DrafterRunInput): Promise<DrafterRunOutput> {
  const instructions = await loadPrompt('drafter');

  const userMessage = JSON.stringify({
    action_type: input.actionType,
    event: input.event,
    memory_slice: input.memorySlice ?? null,
    voice_profile: input.voiceProfile ?? null,
    action_template_hint: input.actionTemplateHint ?? null,
  });

  const startedAt = Date.now();
  const { value: parsed, usage } = await forceToolJson({
    client: anthropicClient(),
    model: SONNET_MODEL,
    system: instructions,
    userMessage,
    toolName: 'draft_action',
    toolDescription: 'Return the structured draft of the proposed action.',
    inputJsonSchema: drafterOutputJsonSchema,
    schema: drafterOutputSchema,
  });

  return {
    draft: {
      id: crypto.randomUUID(),
      eventId: input.event.eventId,
      familyId: input.familyId,
      actionType: input.actionType,
      payload: parsed.payload,
      draftConfidence: parsed.confidence,
      rationale: parsed.rationale,
      recipientVisibility: parsed.recipient_visibility,
      draftedAt: new Date().toISOString(),
    },
    runMetrics: metricsFromUsage('drafter', SONNET_MODEL, usage, Date.now() - startedAt),
  };
}
