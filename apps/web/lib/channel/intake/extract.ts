import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-237 · M2 — the intake extraction stage: names + ages + postal code read out of
 * a parent's free text, accumulated across messages. Prompt is the
 * `intake-extraction` SKILL body (rule #2: never inline). Single forced-tool turn,
 * Zod-validated.
 *
 * Injected behind {@link IntakeExtractor} so the state machine depends on the
 * CONTRACT, not on Anthropic: the machine's tests drive a Fake to exercise routing
 * (rule #8 — the fake is for plumbing only; extraction QUALITY is the eval's job,
 * against real cached Claude in apps/worker/evals/run-intake-eval.mjs).
 */

const MAX_TOKENS = 512;
/** A child at the top of Hale's range (18) is 216 months; the bound rejects a
 * mis-parsed year ("2019" as an age) rather than persisting a nonsense DOB. */
const MAX_AGE_MONTHS = 216;

/**
 * How far the parent narrowed the age down, which is what says how WIDE the band
 * behind the number is:
 *
 * - `years` — a bare year count ("she's four", "6 ans"). That names a 12-month band
 *   whose FLOOR is the number, so the estimate is six months later.
 * - `months` — anything the parent already narrowed ("18 months", "almost 3",
 *   "3 and a half", "6 weeks", "in grade 2"). The number IS the estimate.
 *
 * It has to ride on the wire because nothing downstream can recover it: 42 from
 * "3 and a half" and 42 from a hypothetical "three-and-a-half years" are the same
 * integer, and the correction that is right for one is a six-month error for the other.
 */
export type AgePrecision = 'years' | 'months';

export interface ExtractedChild {
  name: string | null;
  ageMonths: number | null;
  /** Null exactly when {@link ageMonths} is — an unstated age has no granularity. */
  agePrecision: AgePrecision | null;
}

export interface IntakeCollected {
  children: ExtractedChild[];
  postalCode: string | null;
}

export interface IntakeExtractor {
  /** Returns the FULL merged picture: `alreadyKnown` updated by `message`. */
  extract(input: { message: string; alreadyKnown: IntakeCollected }): Promise<IntakeCollected>;
}

/**
 * The default when the model returns an age but omits its granularity. 'months' —
 * i.e. NO midpoint correction — because the two mistakes are not symmetric: reading a
 * child as older than they are drops them out of health-checkpoint windows that never
 * widen at the late edge (lib/health/match.ts), permanently. Reading them slightly
 * young costs a week, because the sweep sees them again.
 */
const DEFAULT_AGE_PRECISION = 'months';

const extractOutputSchema = z.object({
  children: z.array(
    z.object({
      name: z.string().nullable().optional().default(null),
      age_months: z.number().min(0).max(MAX_AGE_MONTHS).nullable().optional().default(null),
      age_precision: z
        .enum(['years', 'months'])
        .nullable()
        .optional()
        .default(DEFAULT_AGE_PRECISION),
    }),
  ),
  postal_code: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1),
});

const extractOutputJsonSchema = {
  type: 'object',
  properties: {
    children: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          age_months: { type: ['number', 'null'], minimum: 0, maximum: MAX_AGE_MONTHS },
          age_precision: { type: ['string', 'null'], enum: ['years', 'months', null] },
        },
      },
    },
    postal_code: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['children', 'confidence'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function extractionUserMessage(input: {
  message: string;
  alreadyKnown: IntakeCollected;
}): string {
  return JSON.stringify({
    message: input.message,
    already_known: {
      children: input.alreadyKnown.children.map((c) => ({
        name: c.name,
        age_months: c.ageMonths,
        age_precision: c.agePrecision,
      })),
      postal_code: input.alreadyKnown.postalCode,
    },
  });
}

export function createIntakeExtractor(client: AgentClient): IntakeExtractor {
  return {
    async extract(input) {
      const skill = await loadCronSkill('intake-extraction');
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: extractionUserMessage(input),
        toolName: 'intake',
        toolDescription: "Return the merged picture of the family's kids and postal code.",
        inputJsonSchema: extractOutputJsonSchema,
        schema: extractOutputSchema,
        maxTokens: MAX_TOKENS,
      });

      return {
        // A child with neither a name nor an age is not a child — it is a failed read,
        // and letting it through would provision an empty row (rule: don't mask).
        children: value.children
          .filter((c) => c.name !== null || c.age_months !== null)
          .map((c) => ({
            name: c.name,
            ageMonths: c.age_months,
            // An unstated age has no granularity to carry, whatever the model said.
            agePrecision:
              c.age_months === null ? null : (c.age_precision ?? DEFAULT_AGE_PRECISION),
          })),
        postalCode: value.postal_code,
      };
    },
  };
}
