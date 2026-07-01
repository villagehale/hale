import { z } from 'zod';
import { pickModel } from '@hale/agent';
import type { ClassifierSuggestion, EventType, FamilyStage } from '@hale/types';
import { anthropicClient } from '../anthropic/client.js';
import { forceToolJson } from './structured.js';
import { metricsFromUsage, type AgentRunMetrics } from './run-metrics.js';
import { dedupHashFor } from './dedup.js';
import { loadPrompt } from '../prompts/loader.js';
import { loadStagePacks, stagePackFor } from './stage-pack.js';

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

const classifierOutputSchema = z.object({
  event_type: eventTypeSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  payload: z.record(z.string(), z.unknown()),
  suggested_action: suggestionSchema,
  /**
   * True when the signal's raw content concerns a teen personally (teen-content,
   * per the teenager pack's redaction rule). Additive + optional with a false
   * default: existing cached eval responses lack it and read as false, so the
   * cached-only eval is unaffected. The orchestrator HARD-CAPS routing on this
   * flag when a teenager is in the family (rule #1 structural enforcement).
   */
  teen_content: z.boolean().optional().default(false),
  /**
   * Which of the family's known children this signal concerns, identified by the
   * child id passed in the context slice — a name match against the family's
   * children, or an unambiguous age/stage cue. Null when undeterminable or
   * family-wide. Additive + optional: existing cached eval responses lack it and
   * read as null, so the cached-only eval is unaffected. The orchestrator
   * VALIDATES the returned id against the known children before persisting
   * events.child_id, so a hallucinated id is dropped to null, not trusted. */
  concerns_child_id: z.string().nullable().optional().default(null),
});

const classifierOutputJsonSchema = {
  type: 'object',
  properties: {
    event_type: { type: 'string', enum: eventTypeSchema.options },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    suggested_action: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['autonomous_action', 'surface_only', 'ignore', 'needs_human'],
        },
        actionType: { type: 'string' },
      },
      required: ['kind'],
    },
    teen_content: { type: 'boolean' },
    concerns_child_id: { type: ['string', 'null'] },
  },
  required: ['event_type', 'confidence', 'rationale', 'payload', 'suggested_action'],
} as const;

interface ClassifierRunInput {
  familyId: string;
  source: string;
  rawContent: string;
  /**
   * Distinct family stages, used to inject stage-aware context packs. The
   * orchestrator derives these from the family's children + dateOfBirth
   * (loadFamilyContext) and passes them in; callers default to ['newborn'].
   */
  stages?: FamilyStage[];
  /**
   * Disambiguation slice. childrenAgesMonths/province/timezone come from the
   * family's rows; knownClinics/knownDaycares are optional — the schema has no
   * source-of-truth for them yet, so the orchestrator omits them rather than
   * fabricating, and fixtures may still supply them.
   *
   * `children` carries the family's known children {id, name, ageInMonths} so the
   * classifier can attribute a signal to a specific child (name match or age/stage
   * cue) and return its id in `concerns_child_id`. Optional: omitted for single-
   * unknown-child contexts and absent from the existing eval fixtures, so their
   * serialized slice is byte-identical and the cached eval is unaffected.
   */
  familyContextSlice?: {
    childrenAgesMonths: number[];
    province: string;
    timezone: string;
    knownClinics?: string[];
    knownDaycares?: string[];
    children?: Array<{ id: string; name: string; ageInMonths: number }>;
  };
}

interface ClassifierRunOutput {
  eventType: EventType;
  payload: Record<string, unknown>;
  confidence: { score: number; rationale: string };
  suggestion: ClassifierSuggestion;
  /** Teen-content flag (teenager pack redaction rule) — drives the orchestrator's
   * structural teen-redaction cap. */
  teenContent: boolean;
  /** Raw child-attribution id the model returned, or null. The orchestrator
   * validates this against the family's known children before persisting. */
  concernsChildId: string | null;
  dedupHash: string;
  runMetrics: AgentRunMetrics;
}

export async function runClassifier(input: ClassifierRunInput): Promise<ClassifierRunOutput> {
  const basePrompt = await loadPrompt('classifier');
  await loadStagePacks();
  const pack = stagePackFor(input.stages ?? ['newborn']);
  const instructions = pack ? `${basePrompt}\n\n${pack}` : basePrompt;

  const dedupHash = dedupHashFor(input.familyId, input.source, input.rawContent);

  const userMessage = JSON.stringify({
    signal: { source: input.source, raw_content: input.rawContent },
    family_context_slice: input.familyContextSlice ?? null,
  });

  const model = pickModel('classify');
  const startedAt = Date.now();
  const { value: parsed, usage } = await forceToolJson({
    client: anthropicClient(),
    model,
    system: instructions,
    userMessage,
    toolName: 'classification',
    toolDescription: 'Return the structured classification of the inbound signal.',
    inputJsonSchema: classifierOutputJsonSchema,
    schema: classifierOutputSchema,
  });

  return {
    eventType: parsed.event_type,
    payload: parsed.payload,
    confidence: { score: parsed.confidence, rationale: parsed.rationale },
    suggestion: parsed.suggested_action,
    teenContent: parsed.teen_content,
    concernsChildId: parsed.concerns_child_id,
    dedupHash,
    runMetrics: metricsFromUsage('classifier', model, usage, Date.now() - startedAt),
  };
}
