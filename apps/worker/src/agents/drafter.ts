import { forceToolJson, pickLane } from '@hale/agent';
import type { ActionType, DraftedAction } from '@hale/types';
import { z } from 'zod';
import { anthropicClient } from '../anthropic/client.js';
import { loadPrompt } from '../prompts/loader.js';
import { type AgentRunMetrics, metricsFromUsage } from './run-metrics.js';

const drafterOutputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  recipient_visibility: z.enum(['public', 'internal_only']),
  commits_parent_to_enrollment_booking_or_payment: z.boolean(),
});

const drafterOutputJsonSchema = {
  type: 'object',
  properties: {
    payload: { type: 'object', additionalProperties: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    recipient_visibility: { type: 'string', enum: ['public', 'internal_only'] },
    commits_parent_to_enrollment_booking_or_payment: { type: 'boolean' },
  },
  required: [
    'payload',
    'confidence',
    'rationale',
    'recipient_visibility',
    'commits_parent_to_enrollment_booking_or_payment',
  ],
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

  const lane = pickLane('draft');
  const startedAt = Date.now();
  const { value: parsed, usage } = await forceToolJson({
    client: anthropicClient(),
    lane,
    system: instructions,
    userMessage,
    toolName: 'draft_action',
    toolDescription: 'Return the structured draft of the proposed action.',
    inputJsonSchema: drafterOutputJsonSchema,
    schema: drafterOutputSchema,
    maxTokens: 4096,
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
      commitsParentToEnrollmentBookingOrPayment:
        parsed.commits_parent_to_enrollment_booking_or_payment,
    },
    runMetrics: metricsFromUsage('drafter', lane.model, usage, Date.now() - startedAt),
  };
}
