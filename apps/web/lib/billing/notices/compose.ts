import type Anthropic from '@anthropic-ai/sdk';
import {
  type AgentClient,
  SPARSE_CACHE_TTL,
  estimateCostUsd,
  pickLane,
  promptCacheHitFromRead,
} from '@hale/agent';
import { z } from 'zod';
import type { RecordAgentRunInput } from '~/lib/agent-run';
import { llmFamilyContext, withLlmContext } from '~/lib/analytics/llm-trace';
import type { ReplyLanguage } from '~/lib/channel/language';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import {
  type BillingClaimFacts,
  type BillingPlanName,
  billingTextConflict,
} from '~/lib/channel/reconcile/billing-text';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-735 · the text after a payment, a cancel or a refund. The model writes all of it
 * from server facts and a second call checks its meaning against them, in any language.
 * If neither produces a sendable text, nothing is sent: there is no fallback copy.
 */

export const BILLING_NOTICE_SKILL = 'billing-notice';
export const BILLING_NOTICE_CHECK_SKILL = 'billing-notice-check';
export const BILLING_NOTICE_TOOL = 'billing_notice_text';
export const BILLING_NOTICE_TOOL_DESCRIPTION = 'The one text Hale sends the parent.';
export const BILLING_NOTICE_MAX_TOKENS = 1024;
export const BILLING_NOTICE_CHECK_TOOL = 'billing_notice_check';
export const BILLING_NOTICE_CHECK_TOOL_DESCRIPTION =
  'Whether every claim in the draft is backed by the facts.';
export const BILLING_NOTICE_CHECK_MAX_TOKENS = 1024;
export const BILLING_NOTICE_MAX_ATTEMPTS = 2;

/** The facts the writer is handed. Nothing here names a person, a card or a child. */
export interface BillingNoticeFacts {
  happened: 'payment' | 'plan_change';
  language: ReplyLanguage;
  plan: BillingPlanName;
  previousPlan: BillingPlanName | null;
  ended: { why: 'cancelled' | 'payment_failed' | null } | null;
  refunds: { amount: string; of: string; full: boolean }[];
  paidThrough: { date: string; renews: boolean } | null;
}

export const BILLING_NOTICE_JSON_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The text Hale sends the parent.' } },
  required: ['text'],
} as const;
const writerSchema = z.object({ text: z.string() });

/** `reason` is first: the model reasons before it decides. */
export const BILLING_NOTICE_CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    supported: { type: 'boolean' },
    unsupported: { type: 'array', items: { type: 'string' } },
  },
  required: ['reason', 'supported', 'unsupported'],
} as const;
const checkSchema = z.object({
  reason: z.string(),
  supported: z.boolean(),
  unsupported: z.array(z.string()),
});

/** The user turn. Shared with the eval, which replays this request shape. */
export function billingNoticeUserMessage(facts: BillingNoticeFacts): string {
  return JSON.stringify(facts);
}

export function billingNoticeCheckMessage(facts: BillingNoticeFacts, draft: string): string {
  return JSON.stringify({ facts, draft });
}

/** Structural refusals only: nothing here reads the meaning or the length of a text. */
export function billingNoticeRefusals(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return ['empty'];
  const found: string[] = [];
  if (hasLinkShape(trimmed)) found.push('link');
  if (trimmed.includes(OPT_OUT_LINE) || trimmed.includes(OPT_OUT_SHORT)) found.push('opt_out_line');
  return found;
}

export type CheckBillingNotice = (input: {
  client: AgentClient;
  facts: BillingNoticeFacts;
  draft: string;
  familyId: string;
  signal: AbortSignal;
}) => Promise<boolean>;

/** A failed or malformed check is not a pass. */
export const checkBillingNotice: CheckBillingNotice = async ({
  client,
  facts,
  draft,
  familyId,
  signal,
}) => {
  try {
    const skill = await loadCronSkill(BILLING_NOTICE_CHECK_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: billingNoticeCheckMessage(facts, draft),
      toolName: BILLING_NOTICE_CHECK_TOOL,
      toolDescription: BILLING_NOTICE_CHECK_TOOL_DESCRIPTION,
      inputJsonSchema: BILLING_NOTICE_CHECK_JSON_SCHEMA,
      schema: checkSchema,
      maxTokens: BILLING_NOTICE_CHECK_MAX_TOKENS,
      signal,
    });
    return value.supported && value.unsupported.length === 0;
  } catch (err) {
    console.warn(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'billing notice: fact check failed, not sendable',
    );
    return false;
  }
};

export type BillingNoticeCompose =
  | { status: 'written'; text: string }
  | { status: 'failed'; reason: 'unwritten' | 'fact_check' };

export interface ComposeBillingNoticeInput {
  /** Null when voice is off or no key is set: a failed attempt, so it retries and pages. */
  client: AgentClient | null;
  facts: BillingNoticeFacts;
  claimFacts: BillingClaimFacts;
  familyId: string;
  recordRun: (run: RecordAgentRunInput) => Promise<void>;
  /** One signal across every model call of this notice. */
  signal: AbortSignal;
  check?: CheckBillingNotice;
}

export type ComposeBillingNotice = (
  input: ComposeBillingNoticeInput,
) => Promise<BillingNoticeCompose>;

export const composeBillingNotice: ComposeBillingNotice = async (input) => {
  const { client, facts, claimFacts, familyId, recordRun, signal } = input;
  const check = input.check ?? checkBillingNotice;
  if (!client) {
    console.error({ familyId }, 'billing notice: no writer client, nothing sent');
    return { status: 'failed', reason: 'unwritten' };
  }
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(BILLING_NOTICE_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'billing notice: skill load failed, nothing sent',
    );
    return { status: 'failed', reason: 'unwritten' };
  }
  const lane = pickLane(skill.meta.task);
  let failure: 'unwritten' | 'fact_check' = 'unwritten';

  for (let attempt = 1; attempt <= BILLING_NOTICE_MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) break;
    const startedAt = Date.now();
    let usage: Anthropic.Usage | null = null;
    let written: string | null = null;
    try {
      const answered = await withLlmContext(
        { stage: 'notice', ...llmFamilyContext(familyId) },
        () =>
          forceToolJson({
            client,
            lane,
            system: skill.instructions,
            cacheTtl: SPARSE_CACHE_TTL,
            userMessage: billingNoticeUserMessage(facts),
            toolName: BILLING_NOTICE_TOOL,
            toolDescription: BILLING_NOTICE_TOOL_DESCRIPTION,
            inputJsonSchema: BILLING_NOTICE_JSON_SCHEMA,
            schema: writerSchema,
            maxTokens: BILLING_NOTICE_MAX_TOKENS,
            signal,
          }),
      );
      usage = answered.usage;
      const text = answered.value.text.trim();
      const refusals = billingNoticeRefusals(text);
      const conflict = refusals.length === 0 ? billingTextConflict(text, claimFacts) : null;
      if (refusals.length > 0 || conflict) {
        console.warn(
          { familyId, attempt, refusals, conflict },
          'billing notice: draft refused, asking again',
        );
      } else if (await check({ client, facts, draft: text, familyId, signal })) {
        written = text;
      } else {
        failure = 'fact_check';
        console.warn({ familyId, attempt }, 'billing notice: draft failed the fact check');
      }
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'billing notice: compose failed',
      );
    }
    const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    await recordRun({
      familyId,
      agentName: 'reply-copy',
      modelUsed: lane.model,
      promptTokens: (usage?.input_tokens ?? 0) + cacheCreation,
      completionTokens: usage?.output_tokens ?? 0,
      costUsd: usage
        ? estimateCostUsd(lane.model, {
            inputTokens: usage.input_tokens,
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
            outputTokens: usage.output_tokens,
          })
        : 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheCreation,
      promptCacheHit: promptCacheHitFromRead(usage ? cacheRead : undefined),
      latencyMs: Date.now() - startedAt,
      status: written === null ? 'failed' : 'completed',
    });
    if (written !== null) return { status: 'written', text: written };
  }
  console.error(
    { familyId, outcome: 'billing_notice_unwritten', failure },
    'billing notice: nothing sent',
  );
  return { status: 'failed', reason: failure };
};
