import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import type { CoachRunMetrics } from './coach';
import {
  appendMessage,
  createConversation,
  loadTranscript,
  resolveConversationForFamily,
} from './conversation';
import { loadAgentContext } from './context';
import { buildGuardDeps } from './guards';
import { recordCoachRun } from './record-run';
import { loadAskHaleSkill } from './skill';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { buildAskHaleTools } from './tools';

/**
 * Ask Hale on the @hale/agent harness — multi-turn, memory-backed, fully
 * family-scoped. This REPLACES the old single Anthropic call (coach.ts).
 *
 * The flow: resolve (or open) the family's conversation, load its transcript,
 * persist the new question, assemble the family context (parent, non-teen child
 * detail, location, plan, memory, transcript — rule #1), then run the agent loop.
 * The harness picks the model from the skill's task (converse → Sonnet), dispatches
 * every tool through the GUARDED invoker (cap / audit / teen-redaction), and hard-
 * stops at maxSteps. The assistant answer is persisted, the run cost recorded.
 *
 * The Anthropic client is injected so tests drive the loop MECHANICS with a fake;
 * agent QUALITY is an eval against real cached Claude (rule #8), not asserted here.
 */

const MAX_STEPS = 6;
const MAX_TOKENS = 1024;

/** Sonnet token rates, USD per 1M — mirrors coach.ts / the worker cost table. */
const SONNET_RATE = { inputPerMTok: 3, outputPerMTok: 15 } as const;
const PER_MTOK = 1_000_000;

export interface AskHaleInput {
  familyId: string;
  question: string;
  intent: string | null;
  /** Continue an existing thread, or null to start a fresh one. */
  conversationId: string | null;
  /** The acting parent's user id — written to audit_log.actor (rule #6 / PIPEDA). */
  actor: string;
}

export interface AskHaleResult {
  answer: string;
  conversationId: string;
  metrics: CoachRunMetrics;
}

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  defaultClient ??= new Anthropic({ apiKey });
  return defaultClient;
}

export async function askHale(
  input: AskHaleInput,
  database: Database,
  client: AgentClient = anthropicClient(),
): Promise<AskHaleResult> {
  // Continue the caller's thread only if it exists AND belongs to their family
  // (rule #1); an unknown or cross-family id is not an error — it starts a fresh
  // thread rather than leaking into another family's conversation.
  const existing = input.conversationId
    ? await resolveConversationForFamily(input.conversationId, input.familyId, database)
    : null;
  const conversationId = existing ?? (await createConversation(input.familyId, database));

  const transcript = await loadTranscript(conversationId, database);
  await appendMessage(conversationId, 'user', input.question, database);

  const context = await loadAgentContext(
    { familyId: input.familyId, question: input.question, intent: input.intent, transcript },
    database,
  );

  const skill = await loadAskHaleSkill();
  const tools = buildAskHaleTools(database);
  const guardDeps = buildGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  // Trace the multi-turn run: sessionId = conversationId groups the thread, the
  // acting parent is userId, familyId is correlating metadata, planTier is a
  // filterable segment. The mask keeps teen/PII out of the trace (rule #1).
  return traceAgentRun(
    {
      name: 'ask-hale',
      sessionId: conversationId,
      userId: input.actor,
      tags: ['ask-hale', context.planTier],
      metadata: { familyId: input.familyId },
    },
    async (trace) => {
      const startedAt = Date.now();
      const result = await runAgent({
        skill,
        context,
        tools,
        client,
        maxSteps: MAX_STEPS,
        maxTokens: MAX_TOKENS,
        toolContext: { familyId: input.familyId, actor: input.actor },
        guardDeps,
      });

      trace.recordGeneration('ask-hale-loop', { model: modelUsed, usage: result.usage });

      const costUsd =
        (result.usage.promptTokens * SONNET_RATE.inputPerMTok) / PER_MTOK +
        (result.usage.completionTokens * SONNET_RATE.outputPerMTok) / PER_MTOK;
      const metrics: CoachRunMetrics = {
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd,
        latencyMs: Date.now() - startedAt,
      };

      if (result.answer === null) {
        // Rule #8: a run that produced no answer is a failed run — record it as such
        // (real model + accumulated usage), then surface the error rather than swallow.
        await recordCoachRun(input.familyId, metrics, database, 'failed', trace.traceId);
        throw new Error(
          result.hitMaxSteps
            ? 'askHale: agent hit maxSteps without an answer'
            : 'askHale: agent returned no answer',
        );
      }

      await appendMessage(conversationId, 'assistant', result.answer, database);
      await recordCoachRun(input.familyId, metrics, database, 'completed', trace.traceId);

      return { answer: result.answer, conversationId, metrics };
    },
  );
}
