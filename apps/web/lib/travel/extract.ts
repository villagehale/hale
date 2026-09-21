import type { AgentClient, Skill } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE ONE MODEL CALL IN THE TRAVEL LANE — a booking email's full body becomes six
 * scalars.
 *
 * The shape is {@link extractChildEvent}'s, verbatim: `forceToolJson`,
 * `pickLane(skill.meta.task)`, Zod at the boundary, the body passed in and NEVER returned
 * or persisted. `fetchGmailMessageBody` hands the caller a string held in one stack frame
 * (BODY_RETENTION = 'transient-per-extraction-call'); this function reads it and gives
 * back a city, a region, two dates, a category and a number.
 *
 * WHAT CROSSES THE BORDER, said plainly rather than left to "never a name" to cover: the
 * booking email's BODY and the household children's FIRST NAMES go to Sonnet 5 in
 * Anthropic's US region. `named_traveller` is a string match against those names and
 * there is no way to derive it without them. The sentinel makes the same disclosure for
 * the same reason; the two differences are that this lane sends NO ageInMonths (nothing
 * here dates an event against a child's age, so an age would cross for no reader), and
 * that what may reach it at all is bounded by a deterministic two-token pre-filter rather
 * than by a model judgement.
 */

/**
 * 1024, not 512.
 *
 * The extract lane is `{ thinking: 'adaptive', effort: 'high' }` and `max_tokens` bounds
 * thinking PLUS the tool call — nothing bounds thinking alone. `forceToolJson` THROWS on
 * `stop_reason === 'max_tokens'` with no re-ask, so a tight ceiling is not a smaller
 * answer, it is `extract_failed`. 1024 is the sentinel's number for the same lane over a
 * LARGER schema, which is the only ceiling in the repo with production evidence behind
 * it. "Six scalar fields" is an argument about output, and the ceiling is not about
 * output.
 */
const MAX_TOKENS = 1024;

export const CHILD_EVIDENCE_VALUES = ['named_traveller', 'child_fare', 'none'] as const;
export type TravelChildEvidence = (typeof CHILD_EVIDENCE_VALUES)[number];

/**
 * EVERY FIELD IS `.optional().default(...)` AND FAILS CLOSED.
 *
 * On a non-strict tool `required` is advisory and the model skips optional attributes —
 * the recorded failure mode that dropped whole discovery batches. So an omission is a
 * DEFAULT here rather than a ZodError, and each default is the silent answer:
 *   · `destination_city: null` → the outcome `no_destination`, nothing written;
 *   · `child_evidence: 'none'` → `no_child_evidence`, nothing written;
 *   · `confidence: 0`          → `low_confidence`, nothing written.
 *
 * `confidence` in particular is DEFAULTED rather than required, because required it was
 * the one way an omission became `extract_failed` — a fault — instead of the silence the
 * precision rule asks for.
 */
const travelSchema = z.object({
  destination_city: z.string().nullable().optional().default(null),
  destination_region: z.string().nullable().optional().default(null),
  start_date: z.string().nullable().optional().default(null),
  end_date: z.string().nullable().optional().default(null),
  child_evidence: z.enum(CHILD_EVIDENCE_VALUES).optional().default('none'),
  confidence: z.number().min(0).max(1).optional().default(0),
});

/** The tool's own schema. Exported because the eval suite sends exactly this — a corpus
 * grading a different schema than production is a corpus measuring a different model. */
export const travelToolJsonSchema = {
  type: 'object',
  properties: {
    destination_city: {
      type: ['string', 'null'],
      description: 'The municipality travelled TO. Never a street, a property or a district.',
    },
    destination_region: {
      type: ['string', 'null'],
      description: 'The province, state or country, when the email states it plainly.',
    },
    start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD departure / check-in.' },
    end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD return / check-out, or null.' },
    child_evidence: {
      type: 'string',
      enum: [...CHILD_EVIDENCE_VALUES],
      description: "Why the booking's own text says a child is travelling, or 'none'.",
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['destination_city', 'start_date', 'child_evidence', 'confidence'],
} as const;

export interface TravelExtractInput {
  subject: string;
  from: string;
  body: string;
  receivedAt: string;
  /** FIRST NAMES ONLY, and only the children's. No ids, no ages: `child_evidence` is a
   * string match, and nothing in this lane dates anything against a child's age. */
  childFirstNames: readonly string[];
}

export interface TravelExtraction {
  destinationCity: string | null;
  destinationRegion: string | null;
  startDate: string | null;
  endDate: string | null;
  childEvidence: TravelChildEvidence;
  confidence: number;
  usage: { promptTokens: number; completionTokens: number };
}

/** The skill, through the same resolveRepoFile + per-name cache the sentinel's two use
 * (rule #2: prompts by reference, never inline). */
export function loadExtractTravelBookingSkill(): Promise<Skill> {
  return loadCronSkill('extract-travel-booking');
}

export async function extractTravelBooking(
  input: TravelExtractInput,
  client: AgentClient,
): Promise<TravelExtraction> {
  const skill = await loadExtractTravelBookingSkill();
  const userMessage = JSON.stringify({
    email: { subject: input.subject, from: input.from, body: input.body },
    received_at: input.receivedAt,
    household_child_first_names: input.childFirstNames,
  });

  const { value, usage } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage,
    toolName: 'travel_booking',
    toolDescription: 'Return the structured travel-booking extraction.',
    inputJsonSchema: travelToolJsonSchema,
    schema: travelSchema,
    maxTokens: MAX_TOKENS,
  });

  return {
    destinationCity: value.destination_city,
    destinationRegion: value.destination_region,
    startDate: value.start_date,
    endDate: value.end_date,
    childEvidence: value.child_evidence,
    confidence: value.confidence,
    usage: {
      promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
    },
  };
}
