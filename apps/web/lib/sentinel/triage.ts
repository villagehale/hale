import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import { z } from 'zod';
import { forceToolJson } from '~/lib/pipeline/structured';
import { loadTriageChildEventSkill } from './skill';
import type { InboxEnvelope } from './types';

/**
 * Triage stage — the cheap first pass (Haiku via pickModel('triage')). Envelope
 * ONLY (subject/from/snippet, no body — E1 never emits one, and this stage never
 * fetches one) → child_related bool + confidence. The prompt is the
 * triage-child-event SKILL body (rule #2: never inline). Single LLM turn via
 * forced-tool JSON, Zod-validated at the boundary.
 *
 * This is the cost-shaping gate: it exists to discard >95% of inbox noise before
 * `extractChildEvent` ever fetches a body (extraction is the expensive Sonnet
 * stage).
 */

const MAX_TOKENS = 256;

const triageOutputSchema = z.object({
  child_related: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const triageOutputJsonSchema = {
  type: 'object',
  properties: {
    child_related: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
  },
  required: ['child_related', 'confidence', 'rationale'],
} as const;

export interface TriageResult {
  childRelated: boolean;
  confidence: number;
  rationale: string;
  usage: { promptTokens: number; completionTokens: number };
}

export async function triageEmail(
  envelope: Pick<InboxEnvelope, 'subject' | 'from' | 'snippet'>,
  childNames: readonly string[],
  client: AgentClient,
): Promise<TriageResult> {
  const skill = await loadTriageChildEventSkill();
  const userMessage = JSON.stringify({
    envelope: { subject: envelope.subject, from: envelope.from, snippet: envelope.snippet },
    children: childNames,
  });

  const { value, usage } = await forceToolJson({
    client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage,
    toolName: 'triage',
    toolDescription: 'Return whether this envelope is worth a full-body fetch.',
    inputJsonSchema: triageOutputJsonSchema,
    schema: triageOutputSchema,
    maxTokens: MAX_TOKENS,
  });

  return {
    childRelated: value.child_related,
    confidence: value.confidence,
    rationale: value.rationale,
    usage: {
      promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
    },
  };
}
