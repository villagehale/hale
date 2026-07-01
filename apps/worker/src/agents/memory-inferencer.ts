import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { pickModel } from '@hale/agent';
import { anthropicClient } from '../anthropic/client.js';
import { forceToolJson } from './structured.js';
import { metricsFromUsage, type AgentRunMetrics } from './run-metrics.js';
import { loadPrompt } from '../prompts/loader.js';
import {
  upsertMemoryFact,
  appendMemoryEpisode,
  retireMemoryFact,
} from '../services/memory-writer.js';

/**
 * Memory Inferencer — Sonnet, batched (nightly or after a burst). Reads a
 * family's recent events + actions + current memory snapshot and derives the
 * long-term facts/episodes other agents consult. High-precision by design: the
 * prompt and a hard 0.7 confidence floor here both bias toward recording fewer,
 * surer facts (a wrong fact poisons every downstream draft).
 */

/** The closed fact_type set — mirrors memoryFactTypeEnum in @hale/db. */
const FACT_TYPES = [
  'preference',
  'routine',
  'medical',
  'logistic',
  'relationship',
  'voice',
] as const;

/** Facts below this confidence are dropped, never written (prompt rule + here). */
const CONFIDENCE_FLOOR = 0.7;

const factUpdateSchema = z.object({
  fact_type: z.enum(FACT_TYPES),
  fact_key: z.string().min(1),
  fact_value: z.unknown(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const episodeSummarySchema = z.object({
  episode_type: z.string().min(1),
  summary: z.string().min(1),
  occurred_at: z.string().min(1),
  sentiment_score: z.number().min(-1).max(1).optional(),
});

const inferencerOutputSchema = z.object({
  fact_updates: z.array(factUpdateSchema),
  episode_summaries: z.array(episodeSummarySchema),
  pattern_detections: z.array(
    z.object({ pattern: z.string(), support: z.string(), confidence: z.number() }),
  ),
  retire_facts: z.array(z.string()),
});

const inferencerOutputJsonSchema = {
  type: 'object',
  properties: {
    fact_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fact_type: { type: 'string', enum: FACT_TYPES },
          fact_key: { type: 'string' },
          fact_value: {},
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
        },
        required: ['fact_type', 'fact_key', 'fact_value', 'confidence', 'rationale'],
      },
    },
    episode_summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          episode_type: { type: 'string' },
          summary: { type: 'string' },
          occurred_at: { type: 'string' },
          sentiment_score: { type: 'number', minimum: -1, maximum: 1 },
        },
        required: ['episode_type', 'summary', 'occurred_at'],
      },
    },
    pattern_detections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          support: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['pattern', 'support', 'confidence'],
      },
    },
    retire_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['fact_updates', 'episode_summaries', 'pattern_detections', 'retire_facts'],
} as const;

/** The currently-valid facts the inferencer was shown — enough to resolve a
 * retire_facts key back to its fact_type without a probe. Structural subset of
 * a family_memory_facts row. */
interface SnapshotFact {
  factType: (typeof FACT_TYPES)[number];
  factKey: string;
}

export interface InferencerJob {
  familyId: string;
  windowDays: number;
  recentEvents: unknown[];
  recentActions: unknown[];
  /** Snapshot the model diffs against: { facts, episodes } from getMemorySlice. */
  currentMemorySnapshot: { facts: SnapshotFact[]; episodes: unknown[] };
}

export type MemoryInferencerClient = Pick<Anthropic, 'messages'>;

interface MemoryInferencerDeps {
  client?: MemoryInferencerClient;
  upsertFact?: typeof upsertMemoryFact;
  appendEpisode?: typeof appendMemoryEpisode;
  retireFact?: typeof retireMemoryFact;
}

export interface MemoryInferencerResult {
  runMetrics: AgentRunMetrics;
  factsWritten: number;
  factsDropped: number;
  episodesWritten: number;
  factsRetired: number;
}

export async function runMemoryInferencer(
  job: InferencerJob,
  deps: MemoryInferencerDeps = {},
): Promise<MemoryInferencerResult> {
  const client = deps.client ?? anthropicClient();
  const upsertFact = deps.upsertFact ?? upsertMemoryFact;
  const appendEpisode = deps.appendEpisode ?? appendMemoryEpisode;
  const retireFact = deps.retireFact ?? retireMemoryFact;

  const instructions = await loadPrompt('memory-inferencer');

  const userMessage = JSON.stringify({
    recent_events: job.recentEvents,
    recent_actions: job.recentActions,
    current_memory_snapshot: job.currentMemorySnapshot,
  });

  const model = pickModel('infer');
  const startedAt = Date.now();
  const { value: parsed, usage } = await forceToolJson({
    client,
    model,
    system: instructions,
    userMessage,
    toolName: 'record_inference',
    toolDescription: 'Record the derived facts, episodes, and retirements for this family.',
    inputJsonSchema: inferencerOutputJsonSchema,
    schema: inferencerOutputSchema,
  });

  let factsWritten = 0;
  let factsDropped = 0;
  for (const fact of parsed.fact_updates) {
    // The 0.7 floor is enforced here as well as in the prompt: a fact the model
    // emits below the floor is dropped, never written.
    if (fact.confidence < CONFIDENCE_FLOOR) {
      factsDropped += 1;
      continue;
    }
    await upsertFact({
      familyId: job.familyId,
      factType: fact.fact_type,
      factKey: fact.fact_key,
      factValue: fact.fact_value,
      confidence: fact.confidence,
      inferredBy: 'memory_inferencer',
    });
    factsWritten += 1;
  }

  let episodesWritten = 0;
  for (const episode of parsed.episode_summaries) {
    await appendEpisode({
      familyId: job.familyId,
      occurredAt: new Date(episode.occurred_at),
      episodeType: episode.episode_type,
      summary: episode.summary,
      sentimentScore: episode.sentiment_score,
    });
    episodesWritten += 1;
  }

  const factTypeByKey = new Map(
    job.currentMemorySnapshot.facts.map((f) => [f.factKey, f.factType]),
  );
  let factsRetired = 0;
  for (const factKey of parsed.retire_facts) {
    // retire_facts gives only a fact_key; resolve its fact_type from the snapshot
    // the model was shown (a fact_key it asks to retire must have been valid and
    // therefore present in the snapshot). A key not in the snapshot is ignored —
    // the model can only retire what it actually saw.
    const factType = factTypeByKey.get(factKey);
    if (!factType) continue;
    const { retired } = await retireFact({ familyId: job.familyId, factType, factKey });
    if (retired) factsRetired += 1;
  }

  return {
    runMetrics: metricsFromUsage(
      'memory_inferencer',
      model,
      usage,
      Date.now() - startedAt,
    ),
    factsWritten,
    factsDropped,
    episodesWritten,
    factsRetired,
  };
}
