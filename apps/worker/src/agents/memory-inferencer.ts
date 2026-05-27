import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic } from '../anthropic.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';

const MODEL = 'claude-sonnet-4-6';

const inferencerOutputSchema = z.object({
  fact_updates: z.array(
    z.object({
      fact_type: z.enum(['preference', 'routine', 'medical', 'logistic', 'relationship', 'voice']),
      fact_key: z.string(),
      fact_value: z.unknown(),
      confidence: z.number(),
      rationale: z.string(),
    }),
  ),
  episode_summaries: z.array(
    z.object({
      episode_type: z.string(),
      summary: z.string(),
      occurred_at: z.string(),
      sentiment_score: z.number().optional(),
    }),
  ),
  pattern_detections: z.array(
    z.object({
      pattern: z.string(),
      support: z.string(),
      confidence: z.number(),
    }),
  ),
  retire_facts: z.array(z.string()),
});

interface InferencerJob {
  familyId: string;
  windowDays: number;
  recentEvents?: unknown[];
  recentActions?: unknown[];
  currentMemorySnapshot?: unknown;
}

export async function runMemoryInferencer(job: InferencerJob): Promise<void> {
  const systemPrompt = await loadPrompt('memory-inferencer');

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          family_id: job.familyId,
          recent_events: job.recentEvents ?? [],
          recent_actions: job.recentActions ?? [],
          current_memory_snapshot: job.currentMemorySnapshot ?? null,
        }),
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const parsed = inferencerOutputSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    logger.error(
      { familyId: job.familyId, errors: parsed.error.flatten() },
      'memory inferencer: invalid JSON',
    );
    return;
  }

  // Inference writes are applied via Memory Writer in a subsequent step.
  // For now we log the inferred output; the write path is wired when
  // family_memory_facts upsert helpers land in @mira/db.
  logger.info(
    {
      familyId: job.familyId,
      factUpdates: parsed.data.fact_updates.length,
      episodes: parsed.data.episode_summaries.length,
      patterns: parsed.data.pattern_detections.length,
    },
    'memory inferencer: inferences produced',
  );
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('inferencer output contained no JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
