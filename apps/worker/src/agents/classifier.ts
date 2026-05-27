import { createHash } from 'node:crypto';
import { z } from 'zod';
import { anthropic } from '../anthropic.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';
import type { ClassifierSuggestion, EventType } from '@mira/types';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

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
  payload: z.record(z.unknown()),
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
  const systemPrompt = await loadPrompt('classifier');
  const dedupHash = createHash('sha256')
    .update(`${input.familyId}|${input.source}|${input.rawContent}`)
    .digest('hex');

  const userMessage = JSON.stringify({
    signal: { source: input.source, raw_content: input.rawContent },
    family_context_slice: input.familyContextSlice ?? null,
  });

  const response = await anthropic().messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const parsed = classifierOutputSchema.safeParse(extractJson(text));
  if (!parsed.success) {
    logger.error(
      { familyId: input.familyId, raw: text, errors: parsed.error.flatten() },
      'classifier: invalid JSON output',
    );
    throw new Error(`Classifier returned invalid JSON: ${parsed.error.message}`);
  }

  return {
    eventType: parsed.data.event_type,
    payload: parsed.data.payload,
    confidence: { score: parsed.data.confidence, rationale: parsed.data.rationale },
    suggestion: parsed.data.suggested_action,
    dedupHash,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Extracts the first valid JSON object from a model response. Models
 * sometimes prefix or suffix JSON with prose — we tolerate that without
 * fragile string slicing.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Direct parse first (the prompt instructs JSON-only).
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to brace-extract.
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('classifier output contained no JSON object');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

// Type-only import for the SDK's content-block discriminator
import type Anthropic from '@anthropic-ai/sdk';
