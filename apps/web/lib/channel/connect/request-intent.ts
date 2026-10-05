import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { claimOpsPage } from '~/lib/monitoring/ops-page-claim';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  REQUEST_INTENT_LABELS,
  REQUEST_INTENT_SKILL,
  type RequestIntentAnswer,
  type RequestIntentInput,
  type RequestIntentReading,
  requestIntentUserMessage,
  settleRequestIntent,
} from './request-intent-reading';

export {
  PROVIDER_OF_INTENT,
  REQUEST_INTENT_CONFIDENCE_MIN,
  REQUEST_INTENT_SKILL,
  type ConnectRequestIntent,
  type RequestIntentAnswer,
  type RequestIntentInput,
  type RequestIntentLabel,
  type RequestIntentReading,
  type RequestSetting,
  isConnectIntent,
  requestIntentUserMessage,
  settleRequestIntent,
} from './request-intent-reading';

/**
 * VIL-413 / VIL-417 · the model reads a parent's message for an actionable request (a
 * connect-by-link ask, a both-free ask). Prompt is the `request-intent` SKILL body
 * (rule #2); the guards are in request-intent-reading.ts.
 *
 * On the `classify` lane: this runs ahead of the coach on inbound texts, so it is the
 * cheap, fast tier. The coach still answers everything this reads as `other`.
 */

const MAX_TOKENS = 256;

export interface RequestIntentReader {
  read(input: RequestIntentInput): Promise<RequestIntentAnswer>;
}

export type RequestIntentFailure = 'reader_unavailable' | 'model_failed';

export interface RequestIntentResult extends RequestIntentReading {
  /** Named when the model could not be asked or answered badly twice; the reading is then `other`. */
  failure: RequestIntentFailure | null;
}

const answerSchema = z.object({
  intent: z.enum(REQUEST_INTENT_LABELS),
  verbatim: z.string(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});

const answerJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...REQUEST_INTENT_LABELS] },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
} as const;

export function createRequestIntentReader(client: AgentClient): RequestIntentReader {
  return {
    async read(input) {
      const skill = await loadCronSkill(REQUEST_INTENT_SKILL);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: requestIntentUserMessage(input),
        toolName: 'intent',
        toolDescription: "Return what the parent's message asks for.",
        inputJsonSchema: answerJsonSchema,
        schema: answerSchema,
        maxTokens: MAX_TOKENS,
      });
      return value;
    },
  };
}

let defaultReader: RequestIntentReader | undefined;

/**
 * The production reader, built once from the environment. `undefined` when no model key
 * is set: {@link readRequestIntent} then names `reader_unavailable`, pages #ops, and the
 * turn goes to the coach — never to a keyword table.
 */
export function defaultRequestIntentReader(): RequestIntentReader | undefined {
  if (defaultReader) return defaultReader;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  defaultReader = createRequestIntentReader(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return defaultReader;
}

/** Skill and reason only. No parent words in #ops. */
function failurePage(reason: RequestIntentFailure): string {
  return `request intent unread skill=${REQUEST_INTENT_SKILL} reason=${reason}`;
}

/**
 * Read one message, through the guards. One retry on a thrown or malformed answer; after
 * that the reading is `other` with the failure named, #ops is paged, and the caller
 * declines the turn so the coach answers the parent.
 *
 * This reader runs on every inbound text that reaches the connector handler, so with a
 * `scope` the page is bounded to ONE per family per day (ops-page-claim.ts): a deploy
 * with no model key must not page on every message a household sends.
 */
export async function readRequestIntent(
  reader: RequestIntentReader | undefined,
  input: RequestIntentInput,
  options: {
    page?: (text: string) => Promise<unknown>;
    scope?: { familyId: string; database?: Database };
  } = {},
): Promise<RequestIntentResult> {
  const fail = async (reason: RequestIntentFailure): Promise<RequestIntentResult> => {
    console.error(
      { reason, skill: REQUEST_INTENT_SKILL, familyId: options.scope?.familyId ?? null },
      'request intent: message not read',
    );
    try {
      if (options.scope?.database) {
        const key = `request-intent:${reason}:${options.scope.familyId}`;
        if (!(await claimOpsPage(options.scope.database, key))) {
          return { intent: 'other', interpretation: reason, failure: reason };
        }
      }
      await (options.page ?? postOpsSlack)(failurePage(reason));
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'request intent: ops page failed',
      );
    }
    return { intent: 'other', interpretation: reason, failure: reason };
  };

  if (!reader) return fail('reader_unavailable');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await reader.read(input);
      return { ...settleRequestIntent(answer, input), failure: null };
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', attempt },
        'request intent: read failed',
      );
    }
  }
  return fail('model_failed');
}
