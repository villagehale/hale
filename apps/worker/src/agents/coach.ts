import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { FrameworkCitation, CoachingFramework } from '@haru/types';
import { sonnetModel } from '../mastra/model.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';

const frameworkSchema = z.enum([
  'karp',
  'ferber',
  'markham',
  'siegel',
  'lansbury',
  'health_canada',
  'aap',
  'cps',
]);

const coachOutputSchema = z.object({
  advice_text: z.string(),
  framework_citations: z.array(
    z.object({
      framework: frameworkSchema,
      reference: z.string(),
      excerpt: z.string().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  follow_up_questions: z.array(z.string()),
  flag_for_pediatrician: z.boolean(),
});

interface CoachRunInput {
  familyId: string;
  childId?: string;
  trigger:
    | { kind: 'user_question'; question: string }
    | { kind: 'proactive'; context: Record<string, unknown> };
  child?: {
    name: string;
    ageInMonths: number;
    biologicalSex?: string;
  };
  parentingStyle?: string;
  memorySlice?: {
    relevantFacts: unknown[];
    relevantEpisodes: unknown[];
  };
}

interface CoachRunOutput {
  adviceText: string;
  frameworkCitations: FrameworkCitation[];
  confidence: number;
  followUpQuestions: string[];
  flagForPediatrician: boolean;
}

export async function runCoach(input: CoachRunInput): Promise<CoachRunOutput> {
  const instructions = await loadPrompt('coach');
  const agent = new Agent({
    id: 'haru-coach',
    name: 'haru-coach',
    instructions,
    model: sonnetModel(),
  });

  const userMessage = JSON.stringify({
    trigger: input.trigger,
    child: input.child ?? null,
    parenting_style: input.parentingStyle ?? null,
    memory_slice: input.memorySlice ?? null,
  });

  const result = await agent.generate(userMessage, {
    structuredOutput: { schema: coachOutputSchema },
  });

  const parsed = result.object;
  if (!parsed) {
    logger.error({ familyId: input.familyId }, 'coach: agent returned no structured output');
    throw new Error('Coach produced no structured output');
  }

  return {
    adviceText: parsed.advice_text,
    frameworkCitations: parsed.framework_citations.map((c) => ({
      framework: c.framework as CoachingFramework,
      reference: c.reference,
      ...(c.excerpt && { excerpt: c.excerpt }),
    })),
    confidence: parsed.confidence,
    followUpQuestions: parsed.follow_up_questions,
    flagForPediatrician: parsed.flag_for_pediatrician,
  };
}
