import { z } from 'zod';

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = 'typesafe-ai/jev';
const TIMEOUT_MS = 3_000;

const responseSchema = z.object({
  answers: z.record(
    z.object({
      choice: z.string(),
      probabilities: z.record(z.number()),
    }),
  ),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
  providerMetadata: z
    .object({
      typesafe: z
        .object({
          confidence: z.union([z.number(), z.record(z.number())]).optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface JevChoiceResult<TChoice extends string> {
  choice: TChoice;
  probabilities: Record<string, number>;
  confidence: number | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface JevChoiceArgs<TChoice extends string> {
  state: unknown;
  question: string;
  instructions: string;
  criteria: Record<TChoice, string>;
}

export type JevChoiceEvaluator<TChoice extends string> = (
  args: JevChoiceArgs<TChoice>,
) => Promise<JevChoiceResult<TChoice>>;

export function meetsJevConfidence<TChoice extends string>(
  result: JevChoiceResult<TChoice>,
  minimumProbability = 0.8,
  minimumMargin = 0.5,
): boolean {
  const selected = result.probabilities[result.choice] ?? 0;
  const runnerUp = Math.max(
    0,
    ...Object.entries(result.probabilities)
      .filter(([choice]) => choice !== result.choice)
      .map(([, probability]) => probability),
  );
  return selected >= minimumProbability && selected - runnerUp >= minimumMargin;
}

interface JevDependencies {
  apiKey?: string;
  fetch?: typeof fetch;
}

export async function evaluateJevChoice<TChoice extends string>(
  args: JevChoiceArgs<TChoice>,
  dependencies: JevDependencies = {},
): Promise<JevChoiceResult<TChoice>> {
  const apiKey =
    dependencies.apiKey ??
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_KEY ??
    process.env.JEV_KEY;
  if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is not set');

  const response = await (dependencies.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      state: args.state,
      questions: {
        [args.question]: {
          type: 'choice',
          instructions: args.instructions,
          criteria: args.criteria,
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`JEV request failed (${response.status})`);

  const parsed = responseSchema.parse(await response.json());
  const answer = parsed.answers[args.question];
  if (!answer || !Object.hasOwn(args.criteria, answer.choice)) {
    throw new Error('JEV returned an invalid choice');
  }
  const rawConfidence = parsed.providerMetadata?.typesafe?.confidence;

  return {
    choice: answer.choice as TChoice,
    probabilities: answer.probabilities,
    confidence:
      typeof rawConfidence === 'number' ? rawConfidence : (rawConfidence?.[args.question] ?? null),
    usage: {
      inputTokens: parsed.usage?.inputTokens ?? 0,
      outputTokens: parsed.usage?.outputTokens ?? 0,
    },
  };
}
