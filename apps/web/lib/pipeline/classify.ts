import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import type { ClassifierSuggestion, EventType } from '@hale/types';
import { z } from 'zod';
import { loadClassifyEventSkill } from './skill';
import { forceToolJson } from './structured';

/**
 * Classify stage — the inbound signal → structured classification, on the
 * @hale/agent harness model routing (classify → Haiku via pickModel). The prompt
 * is the classify-event SKILL body (rule #2: never inline). Single LLM turn via
 * forced-tool JSON; the result is Zod-validated, so a hallucinated event_type /
 * routing is rejected at the boundary rather than trusted downstream.
 */

const MAX_TOKENS = 1024;

const eventTypeSchema = z.enum([
  'pediatric_appointment_reminder',
  'pediatric_appointment_request',
  'lab_results_ready',
  'pediatric_office_message',
  'vaccine_schedule_update',
  'ei_correspondence',
  'provincial_leave_correspondence',
  'employer_hr_correspondence',
  'tax_credit_eligibility_change',
  'supply_low_signal',
  'subscription_renewal_due',
  'order_confirmation',
  'delivery_update',
  'daycare_application_response',
  'daycare_communication',
  'school_communication',
  'activity_signup_open',
  'milestone_photo_detected',
  'family_share_request',
  'calendar_conflict_detected',
  'family_event_invite',
  'legal_milestone_due',
  'age_stage_milestone_due',
  'sleep_pattern_signal',
  'feeding_pattern_signal',
  'unclassified',
]);

const suggestionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('autonomous_action'), actionType: z.string() }),
  z.object({ kind: z.literal('surface_only') }),
  z.object({ kind: z.literal('ignore') }),
  z.object({ kind: z.literal('needs_human') }),
]);

const classifyOutputSchema = z.object({
  event_type: eventTypeSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  payload: z.record(z.string(), z.unknown()),
  suggested_action: suggestionSchema,
  teen_content: z.boolean().optional().default(false),
  concerns_child_id: z.string().nullable().optional().default(null),
});

const classifyOutputJsonSchema = {
  type: 'object',
  properties: {
    event_type: { type: 'string', enum: eventTypeSchema.options },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    suggested_action: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['autonomous_action', 'surface_only', 'ignore', 'needs_human'] },
        actionType: { type: 'string' },
      },
      required: ['kind'],
    },
    teen_content: { type: 'boolean' },
    concerns_child_id: { type: ['string', 'null'] },
  },
  required: ['event_type', 'confidence', 'rationale', 'payload', 'suggested_action'],
} as const;

export interface ClassifyInput {
  source: string;
  rawContent: string;
  familyContextSlice?: {
    childrenAgesMonths: number[];
    province: string;
    timezone: string;
    children?: Array<{ id: string; name: string; ageInMonths: number }>;
  };
}

export interface ClassifyResult {
  eventType: EventType;
  payload: Record<string, unknown>;
  confidence: number;
  rationale: string;
  suggestion: ClassifierSuggestion;
  teenContent: boolean;
  concernsChildId: string | null;
  usage: { promptTokens: number; completionTokens: number };
}

export async function classifyEvent(
  input: ClassifyInput,
  client: AgentClient,
): Promise<ClassifyResult> {
  const skill = await loadClassifyEventSkill();
  const userMessage = JSON.stringify({
    signal: { source: input.source, raw_content: input.rawContent },
    family_context_slice: input.familyContextSlice ?? null,
  });

  const { value, usage } = await forceToolJson({
    client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage,
    toolName: 'classification',
    toolDescription: 'Return the structured classification of the inbound signal.',
    inputJsonSchema: classifyOutputJsonSchema,
    schema: classifyOutputSchema,
    maxTokens: MAX_TOKENS,
  });

  return {
    eventType: value.event_type,
    payload: value.payload,
    confidence: value.confidence,
    rationale: value.rationale,
    suggestion: value.suggested_action,
    teenContent: value.teen_content,
    concernsChildId: value.concerns_child_id,
    usage: {
      promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
    },
  };
}
