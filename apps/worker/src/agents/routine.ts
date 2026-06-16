import type { FamilyStage } from '@hale/types';
import { z } from 'zod';
import { SONNET_MODEL, anthropicClient } from '../anthropic/client.js';
import { loadPrompt } from '../prompts/loader.js';
import type { DiscoveredCandidate } from './discovery-providers/types.js';
import { forceToolJson } from './structured.js';

/**
 * Routine agent — arranges discovered candidates into a light, stage-aware
 * weekly proposal a parent reviews and accepts one item at a time. Single-shot
 * structured output via `forceToolJson` (Sonnet) + the disk `routine` prompt,
 * exactly like the drafter and coach agents.
 *
 * It proposes only; nothing here commits a calendar write (no calendar infra
 * yet — a routine is an internal pin at launch).
 */

const dayEnum = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const routineOutputSchema = z.object({
  routine: z.array(
    z.object({
      day: dayEnum,
      title: z.string(),
      category: z.string(),
      stage_fit_rationale: z.string(),
      candidate_confidence: z.number().min(0).max(1),
    }),
  ),
  rationale: z.string(),
  notes: z.string(),
});

const routineOutputJsonSchema = {
  type: 'object',
  properties: {
    routine: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: dayEnum.options },
          title: { type: 'string' },
          category: { type: 'string' },
          stage_fit_rationale: { type: 'string' },
          candidate_confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['day', 'title', 'category', 'stage_fit_rationale', 'candidate_confidence'],
      },
    },
    rationale: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['routine', 'rationale', 'notes'],
} as const;

type RoutineDay = z.infer<typeof dayEnum>;

export interface RoutineItem {
  day: RoutineDay;
  title: string;
  category: string;
  stageFitRationale: string;
  candidateConfidence: number;
}

export interface RoutineRunInput {
  stage: FamilyStage;
  candidates: DiscoveredCandidate[];
  interests?: string[];
}

export interface RoutineRunOutput {
  routine: RoutineItem[];
  rationale: string;
  notes: string;
}

export async function runRoutine(input: RoutineRunInput): Promise<RoutineRunOutput> {
  const instructions = await loadPrompt('routine');

  const userMessage = JSON.stringify({
    stage: input.stage,
    interests: input.interests ?? null,
    candidates: input.candidates.map((c) => ({
      title: c.title,
      description: c.description,
      area_coarse: c.areaCoarse,
      stage_fit: c.stage,
      confidence: c.confidence,
      source: c.source,
    })),
  });

  const { value: parsed } = await forceToolJson({
    client: anthropicClient(),
    model: SONNET_MODEL,
    system: instructions,
    userMessage,
    toolName: 'submit_routine',
    toolDescription: 'Return the structured weekly routine proposal.',
    inputJsonSchema: routineOutputJsonSchema,
    schema: routineOutputSchema,
  });

  return {
    routine: parsed.routine.map((r) => ({
      day: r.day,
      title: r.title,
      category: r.category,
      stageFitRationale: r.stage_fit_rationale,
      candidateConfidence: r.candidate_confidence,
    })),
    rationale: parsed.rationale,
    notes: parsed.notes,
  };
}
