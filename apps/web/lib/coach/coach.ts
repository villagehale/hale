import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { CoachingFramework, FamilyStage, FrameworkCitation } from '@hearth/types';
import { loadCoachPrompt } from './prompt';
import { loadCoachModel } from './model';

/**
 * Web-side coach call. The coach is interactive parent-facing Q&A — a synchronous
 * request/response, not the async event queue. We mirror the worker's runCoach
 * request shape (same `coaching_response` tool, same JSON schema, same input
 * serialization) instead of importing it: the worker's agent module reaches into
 * its own internal `../anthropic/client.js` / `../prompts/loader.js`, neither
 * exported nor importable from apps/web across the process boundary. The single
 * sources of truth that COULD drift — the system prompt and the model id — are
 * read from the worker's files at request time (see prompt.ts / model.ts).
 *
 * Teen-privacy posture (rule #1): the coach receives STAGES and the parent's
 * question only. It never receives a child's raw content — coach guidance is
 * meta-advice to the parent, worked from stage/pattern, so a teenager's messages
 * are structurally absent from the request, not merely filtered.
 */

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

const COACH_TOOL = 'coaching_response';

/**
 * Sonnet token rates, USD per 1M. Source: Anthropic pricing (claude-api skill
 * model table). Mirrors apps/worker/src/anthropic/cost.ts — the worker's
 * estimateCostUsd isn't importable here, so the rate is replicated the same way
 * the drafter eval replicates it. Rotate when public pricing changes.
 */
const SONNET_RATE = { inputPerMTok: 3, outputPerMTok: 15 } as const;
const PER_MTOK = 1_000_000;

export interface CoachAnswer {
  adviceText: string;
  frameworkCitations: FrameworkCitation[];
  confidence: number;
  followUpQuestions: string[];
  flagForPediatrician: boolean;
}

export interface CoachRunMetrics {
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface CoachResult {
  answer: CoachAnswer;
  metrics: CoachRunMetrics;
}

export interface CoachCallInput {
  question: string;
  /** Distinct stages the family spans, derived from its children (rule #1: no raw child content). */
  stages: FamilyStage[];
}

let client: Anthropic | undefined;

function anthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  client ??= new Anthropic({ apiKey });
  return client;
}

export async function askCoach(input: CoachCallInput): Promise<CoachResult> {
  const system = await loadCoachPrompt();
  const model = await loadCoachModel();

  const userMessage = JSON.stringify({
    trigger: { kind: 'user_question', question: input.question },
    family_stages: input.stages,
    // Family-level parenting style isn't persisted yet (only per-child
    // overrides on children); wiring it into coach context is a follow-up.
    parenting_style: null,
  });

  const startedAt = Date.now();
  const response = await anthropicClient().messages.create({
    model,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: COACH_TOOL,
        description: 'Return the structured coaching response.',
        input_schema: coachOutputJsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: COACH_TOOL },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === COACH_TOOL,
  );
  if (!toolUse) {
    throw new Error(`coach: model returned no ${COACH_TOOL} tool call`);
  }
  const parsed = coachOutputSchema.parse(toolUse.input);

  const promptTokens =
    response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
  const completionTokens = response.usage.output_tokens;
  const costUsd =
    (promptTokens * SONNET_RATE.inputPerMTok) / PER_MTOK +
    (completionTokens * SONNET_RATE.outputPerMTok) / PER_MTOK;

  return {
    answer: {
      adviceText: parsed.advice_text,
      frameworkCitations: parsed.framework_citations.map((c) => ({
        framework: c.framework as CoachingFramework,
        reference: c.reference,
        ...(c.excerpt && { excerpt: c.excerpt }),
      })),
      confidence: parsed.confidence,
      followUpQuestions: parsed.follow_up_questions,
      flagForPediatrician: parsed.flag_for_pediatrician,
    },
    metrics: {
      modelUsed: model,
      promptTokens,
      completionTokens,
      costUsd,
      latencyMs: Date.now() - startedAt,
    },
  };
}
