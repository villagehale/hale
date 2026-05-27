import { createHash } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { ClassifierSuggestion, EventType } from '@mira/types';
import { haikuModel } from '../mastra/model.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';

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
  'activity_signup_open',
  'milestone_photo_detected',
  'family_share_request',
  'calendar_conflict_detected',
  'family_event_invite',
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

const classifierOutputSchema = z.object({
  event_type: eventTypeSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  payload: z.record(z.string(), z.unknown()),
  suggested_action: suggestionSchema,
});

interface ClassifierRunInput {
  familyId: string;
  source: string;
  rawContent: string;
  familyContextSlice?: {
    childrenAgesMonths: number[];
    province: string;
    timezone: string;
    knownClinics: string[];
    knownDaycares: string[];
  };
}

interface ClassifierRunOutput {
  eventType: EventType;
  payload: Record<string, unknown>;
  confidence: { score: number; rationale: string };
  suggestion: ClassifierSuggestion;
  dedupHash: string;
}

export async function runClassifier(input: ClassifierRunInput): Promise<ClassifierRunOutput> {
  const instructions = await loadPrompt('classifier');
  const agent = new Agent({
    id: 'mira-classifier',
    name: 'mira-classifier',
    instructions,
    model: haikuModel(),
  });

  const dedupHash = createHash('sha256')
    .update(`${input.familyId}|${input.source}|${input.rawContent}`)
    .digest('hex');

  const userMessage = JSON.stringify({
    signal: { source: input.source, raw_content: input.rawContent },
    family_context_slice: input.familyContextSlice ?? null,
  });

  const result = await agent.generate(userMessage, {
    structuredOutput: { schema: classifierOutputSchema },
  });

  const parsed = result.object;
  if (!parsed) {
    logger.error({ familyId: input.familyId }, 'classifier: agent returned no structured output');
    throw new Error('Classifier produced no structured output');
  }

  return {
    eventType: parsed.event_type,
    payload: parsed.payload,
    confidence: { score: parsed.confidence, rationale: parsed.rationale },
    suggestion: parsed.suggested_action,
    dedupHash,
  };
}
