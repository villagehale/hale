import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  CHECKIN_INTENT_SKILL,
  CHECK_IN_INTENT_LABELS,
  type CheckInIntentAnswer,
  type CheckInIntentInput,
  type CheckInIntentReading,
  checkInIntentUserMessage,
  settleCheckInIntent,
} from './intent-reading';

export {
  CADENCE_OF_INTENT,
  CHECK_IN_CADENCE_CONFIDENCE_MIN,
  CHECKIN_INTENT_SKILL,
  type CheckInCadenceIntent,
  type CheckInIntentAnswer,
  type CheckInIntentInput,
  type CheckInIntentLabel,
  type CheckInIntentReading,
  checkInIntentUserMessage,
  isCadenceIntent,
  settleCheckInIntent,
} from './intent-reading';

/**
 * VIL-413 / VIL-417 · the model reads a parent's reply in the evening lane. Prompt is the
 * `checkin-intent` SKILL body (rule #2); the guards are in intent-reading.ts.
 *
 * Tiered with `classify`, as the consent reader is: a cadence change is a decision about
 * how often a family hears from Hale for the next month, and the cheap tier loses exactly
 * the "no, it was fine actually" vs "no more of these" distinction this exists to make.
 */

const MAX_TOKENS = 256;

export interface CheckInIntentReader {
  read(input: CheckInIntentInput): Promise<CheckInIntentAnswer>;
}

export type CheckInIntentFailure = 'reader_unavailable' | 'model_failed';

export interface CheckInIntentResult extends CheckInIntentReading {
  /** Named when the model could not be asked or answered badly twice; the reading is then `other`. */
  failure: CheckInIntentFailure | null;
}

const answerSchema = z.object({
  intent: z.enum(CHECK_IN_INTENT_LABELS),
  verbatim: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});

const answerJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...CHECK_IN_INTENT_LABELS] },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
} as const;

export function createCheckInIntentReader(client: AgentClient): CheckInIntentReader {
  return {
    async read(input) {
      const skill = await loadCronSkill(CHECKIN_INTENT_SKILL);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: checkInIntentUserMessage(input),
        toolName: 'intent',
        toolDescription: "Return what the parent's reply is.",
        inputJsonSchema: answerJsonSchema,
        schema: answerSchema,
        maxTokens: MAX_TOKENS,
      });
      return value;
    },
  };
}

let defaultReader: CheckInIntentReader | undefined;

/**
 * The production reader, built once from the environment. `undefined` when no model key
 * is set: {@link readCheckInIntent} then names `reader_unavailable`, pages #ops, and the
 * turn goes to the coach — never to a keyword table.
 */
export function defaultCheckInIntentReader(): CheckInIntentReader | undefined {
  if (defaultReader) return defaultReader;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  defaultReader = createCheckInIntentReader(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return defaultReader;
}

/** Skill and reason only. No parent words in #ops. */
function failurePage(reason: CheckInIntentFailure): string {
  return `check-in intent unread skill=${CHECKIN_INTENT_SKILL} reason=${reason}`;
}

/**
 * Read one reply, through the guards. One retry on a thrown or malformed answer; after
 * that the reading is `other` with the failure named, #ops is paged, and the caller
 * declines the turn so the coach answers the parent. Nothing canned is written down.
 */
export async function readCheckInIntent(
  reader: CheckInIntentReader | undefined,
  input: CheckInIntentInput,
  options: { page?: (text: string) => Promise<unknown> } = {},
): Promise<CheckInIntentResult> {
  const fail = async (reason: CheckInIntentFailure): Promise<CheckInIntentResult> => {
    console.error({ reason, skill: CHECKIN_INTENT_SKILL }, 'check-in intent: reply not read');
    try {
      await (options.page ?? postOpsSlack)(failurePage(reason));
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'check-in intent: ops page failed',
      );
    }
    return { intent: 'other', interpretation: reason, failure: reason };
  };

  if (!reader) return fail('reader_unavailable');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await reader.read(input);
      return { ...settleCheckInIntent(answer, input), failure: null };
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', attempt },
        'check-in intent: read failed',
      );
    }
  }
  return fail('model_failed');
}
