import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic } from '../anthropic.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';
import type { FrameworkCitation, CoachingFramework } from '@mira/types';

const COACH_MODEL = 'claude-sonnet-4-6';

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
  const systemPrompt = await loadPrompt('coach');

  const userMessage = JSON.stringify({
    trigger: input.trigger,
    child: input.child ?? null,
    parenting_style: input.parentingStyle ?? null,
    memory_slice: input.memorySlice ?? null,
  });

  const response = await anthropic().messages.create({
    model: COACH_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const parsed = coachOutputSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    logger.error(
      { familyId: input.familyId, errors: parsed.error.flatten() },
      'coach: invalid JSON output',
    );
    throw new Error(`Coach returned invalid JSON: ${parsed.error.message}`);
  }

  return {
    adviceText: parsed.data.advice_text,
    frameworkCitations: parsed.data.framework_citations.map((c) => ({
      framework: c.framework as CoachingFramework,
      reference: c.reference,
      ...(c.excerpt && { excerpt: c.excerpt }),
    })),
    confidence: parsed.data.confidence,
    followUpQuestions: parsed.data.follow_up_questions,
    flagForPediatrician: parsed.data.flag_for_pediatrician,
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('coach output contained no JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
