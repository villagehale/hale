import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import { z } from 'zod';
import { forceToolJson } from '~/lib/pipeline/structured';
import { loadExtractChildEventSkill } from './skill';
import type { ExtractedEvent, ExtractionKind, FamilyChildRef } from './types';

/**
 * Extraction stage — typed extraction (Sonnet 5 via pickModel('extract'), tiered
 * with `classify` for the same reason: it carries a teen_content safety call —
 * rule #1) over the FULL body, fetched on-demand by the caller only for
 * triage-positives. The prompt is the extract-child-event SKILL body (rule #2:
 * never inline). Single LLM turn via forced-tool JSON, Zod-validated.
 *
 * The body is passed in as `body` and is NEVER returned or persisted by this
 * function — only the typed fields + the one `quote_evidence` sentence survive
 * (rule #1, E1 retention: the caller holds the body only for this call).
 */

const MAX_TOKENS = 1024;

const EXTRACTION_KINDS = [
  'cancellation',
  'reschedule',
  'new_event',
  'reminder_only',
  'unclear',
] as const satisfies readonly ExtractionKind[];
const extractionKindSchema = z.enum(EXTRACTION_KINDS);

const extractOutputSchema = z.object({
  kind: extractionKindSchema,
  event: z.object({
    title: z.string(),
    child_ref: z.string().nullable().optional().default(null),
    original_time: z.string().nullable().optional().default(null),
    new_time: z.string().nullable().optional().default(null),
    location: z.string().nullable().optional().default(null),
  }),
  source_confidence: z.number().min(0).max(1),
  quote_evidence: z.string(),
  teen_content: z.boolean().optional().default(false),
});

const extractOutputJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: extractionKindSchema.options },
    event: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        child_ref: { type: ['string', 'null'] },
        original_time: { type: ['string', 'null'] },
        new_time: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
      },
      required: ['title'],
    },
    source_confidence: { type: 'number', minimum: 0, maximum: 1 },
    quote_evidence: { type: 'string' },
    teen_content: { type: 'boolean' },
  },
  required: ['kind', 'event', 'source_confidence', 'quote_evidence'],
} as const;

export interface ExtractInput {
  subject: string;
  from: string;
  body: string;
  receivedAt: string;
  familyTimezone: string;
  children: readonly FamilyChildRef[];
}

export interface ExtractResult {
  kind: ExtractionKind;
  event: ExtractedEvent;
  sourceConfidence: number;
  quoteEvidence: string;
  teenContent: boolean;
  usage: { promptTokens: number; completionTokens: number };
}

export async function extractChildEvent(
  input: ExtractInput,
  client: AgentClient,
): Promise<ExtractResult> {
  const skill = await loadExtractChildEventSkill();
  const userMessage = JSON.stringify({
    email: { subject: input.subject, from: input.from, body: input.body },
    received_at: input.receivedAt,
    family_timezone: input.familyTimezone,
    children: input.children.map((c) => ({ id: c.id, name: c.name, ageInMonths: c.ageInMonths })),
  });

  const { value, usage } = await forceToolJson({
    client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage,
    toolName: 'extraction',
    toolDescription: 'Return the structured child-event extraction.',
    inputJsonSchema: extractOutputJsonSchema,
    schema: extractOutputSchema,
    maxTokens: MAX_TOKENS,
  });

  return {
    kind: value.kind,
    event: {
      title: value.event.title,
      childRef: value.event.child_ref,
      originalTime: value.event.original_time,
      newTime: value.event.new_time,
      location: value.event.location,
    },
    sourceConfidence: value.source_confidence,
    quoteEvidence: value.quote_evidence,
    teenContent: value.teen_content,
    usage: {
      promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
    },
  };
}
