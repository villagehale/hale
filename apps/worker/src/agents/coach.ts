import { z } from 'zod';
import type { FrameworkCitation, CoachingFramework, FamilyStage } from '@hearth/types';
import { stageFromAgeInMonths } from '@hearth/types';
import { anthropicClient, SONNET_MODEL } from '../anthropic/client.js';
import { forceToolJson } from './structured.js';
import { loadPrompt } from '../prompts/loader.js';
import { loadStagePacks, stagePackFor } from './stage-pack.js';

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

const coachOutputJsonSchema = {
  type: 'object',
  properties: {
    advice_text: { type: 'string' },
    framework_citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          framework: { type: 'string', enum: frameworkSchema.options },
          reference: { type: 'string' },
          excerpt: { type: 'string' },
        },
        required: ['framework', 'reference'],
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    follow_up_questions: { type: 'array', items: { type: 'string' } },
    flag_for_pediatrician: { type: 'boolean' },
  },
  required: [
    'advice_text',
    'framework_citations',
    'confidence',
    'follow_up_questions',
    'flag_for_pediatrician',
  ],
} as const;

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
  const basePrompt = await loadPrompt('coach');
  await loadStagePacks();
  // Coach is scoped to a single child, so its stage derives directly from
  // that child's age. With no child (a general family query), default to
  // newborn — the same loud default the classifier uses until the children
  // lookup is wired (see ClassifierRunInput.stages TODO).
  const stages: FamilyStage[] = input.child
    ? [stageFromAgeInMonths(input.child.ageInMonths)]
    : ['newborn'];
  const pack = stagePackFor(stages);
  const instructions = pack ? `${basePrompt}\n\n${pack}` : basePrompt;

  const userMessage = JSON.stringify({
    trigger: input.trigger,
    child: input.child ?? null,
    parenting_style: input.parentingStyle ?? null,
    memory_slice: input.memorySlice ?? null,
  });

  const { value: parsed } = await forceToolJson({
    client: anthropicClient(),
    model: SONNET_MODEL,
    system: instructions,
    userMessage,
    toolName: 'coaching_response',
    toolDescription: 'Return the structured coaching response.',
    inputJsonSchema: coachOutputJsonSchema,
    schema: coachOutputSchema,
  });

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
